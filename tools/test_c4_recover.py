#!/usr/bin/env python3
"""Tests for the Control4 outage recovery tooling.

Stdlib only, no test framework to install — the point is that this runs on
the machine that is standing in front of a broken house:

    python3 tools/test_c4_recover.py

A fake Home Assistant answers on localhost so the whole decision tree
(diagnose → reload → repoint → restart → verify) is exercised against real
HTTP, with the real entity map, without touching the Green.
"""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import mock

try:                       # optional: the structural YAML assertions below
    import yaml            # degrade to skips rather than break stdlib-only.
except ImportError:        # pragma: no cover
    yaml = None

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


c4 = load(os.path.join(HERE, "c4_recover.py"), "c4_recover")
repoint = load(os.path.join(ROOT, "ha", "c4_repoint.py"), "c4_repoint")
scan = load(os.path.join(ROOT, "ha", "c4_scan.py"), "c4_scan")

LIGHTS = c4.control4_light_entities() or []
ENTRY_ID = "01HQZC4ENTRY"
OLD_HOST = "10.0.0.33"
NEW_HOST = "10.0.0.42"


class FakeHouse:
    """The Green, as far as this tool can tell.

    `down` is how many of the Control4 lights are unavailable — all of them by
    default, which is what an integration outage looks like. The fake clears
    it exactly when the real one would: on a reload that gets past cloud auth,
    or on a restart once the entry's host finally matches where the controller
    answers.
    """

    def __init__(self, *, down=None, host=OLD_HOST, observed=NEW_HOST,
                 controller_at=None, reload_fixes=False, has_shell_command=True,
                 clobber_writes=0):
        self.down = len(LIGHTS) if down is None else down
        self.host = host
        self.observed = observed          # what the ARP scan reports
        self._controller_at = controller_at
        self.reload_fixes = reload_fixes
        self.has_shell_command = has_shell_command
        self.clobber_writes = clobber_writes  # HA saving .storage over our edit
        self.calls = []

    @property
    def lights_up(self):
        return self.down == 0

    @property
    def controller_at(self):
        """Where the controller REALLY is — normally whatever the scan
        reports, including when a test moves it mid-run. They part company
        only when a test says so, to model a scan latching onto some other
        machine."""
        return self._controller_at or self.observed

    def service(self, domain, service, data):
        self.calls.append((domain, service, data))
        if (domain, service) == ("homeassistant", "reload_config_entry"):
            if self.reload_fixes:
                self.down = 0
            return 200, "[]"
        if (domain, service) == ("shell_command", "c4_repoint"):
            if not self.has_shell_command:
                return 400, '{"message": "Service shell_command.c4_repoint not found"}'
            if self.clobber_writes > 0:
                self.clobber_writes -= 1  # write accepted, then lost to a save
                return 200, "[]"
            # The real service takes no data: it resolves the controller by
            # MAC and points the entry there. Anything sent is ignored.
            self.host = self.observed
            return 200, "[]"
        if (domain, service) == ("homeassistant", "restart"):
            if self.host == self.controller_at:
                self.down = 0
            return 200, "[]"
        return 200, "[]"

    def states(self):
        out = [{"entity_id": e,
                "state": "unavailable" if i < self.down else "off",
                "attributes": {}} for i, e in enumerate(LIGHTS)]
        out.append({"entity_id": c4.IP_SENSOR, "state": self.observed or "unknown",
                    "attributes": {}})
        out.append({"entity_id": c4.HOST_SENSOR, "state": self.host or "none",
                    "attributes": {}})
        return out

    def error_log(self):
        if self.lights_up:
            return "INFO (MainThread) [homeassistant.setup] Setup of control4 took 1.2s\n"
        return (
            "ERROR (MainThread) [homeassistant.config_entries] Config entry for control4 "
            f"not ready yet: Timeout connecting to Control4 controller at {self.host}\n"
        )


class Handler(BaseHTTPRequestHandler):
    house = None

    def log_message(self, *args):
        pass

    def _send(self, status, body, content_type="application/json"):
        payload = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        house = Handler.house
        if self.path == "/api/":
            return self._send(200, '{"message": "API running."}')
        if self.path == "/api/states":
            return self._send(200, json.dumps(house.states()))
        if self.path.startswith("/api/states/"):
            wanted = self.path.rsplit("/", 1)[1]
            for state in house.states():
                if state["entity_id"] == wanted:
                    return self._send(200, json.dumps(state))
            return self._send(404, '{"message": "Entity not found."}')
        if self.path == "/api/error_log":
            return self._send(200, house.error_log(), "text/plain")
        if self.path == "/api/config/config_entries/entry":
            return self._send(200, json.dumps([
                {"entry_id": "other", "domain": "coolmaster", "state": "loaded"},
                {"entry_id": ENTRY_ID, "domain": "control4",
                 "state": "loaded" if house.lights_up else "setup_retry"},
            ]))
        return self._send(404, '{"message": "not found"}')

    def do_POST(self):
        house = Handler.house
        length = int(self.headers.get("Content-Length") or 0)
        data = json.loads(self.rfile.read(length) or "{}")
        if self.path.startswith("/api/services/"):
            domain, service = self.path[len("/api/services/"):].split("/", 1)
            return self._send(*house.service(domain, service, data))
        if self.path == "/api/template":
            return self._send(200, ENTRY_ID, "text/plain")
        return self._send(404, '{"message": "not found"}')


@contextlib.contextmanager
def serving(house):
    Handler.house = house
    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


def run_cli(url, *args):
    """Drive the CLI exactly as a person would, and capture what they'd see."""
    out = io.StringIO()
    argv = ["c4_recover.py", *args, "--url", url, "--token", "test-token"]
    with mock.patch.object(sys, "argv", argv), \
         mock.patch("time.sleep"), \
         contextlib.redirect_stdout(out):
        try:
            code = c4.main() or 0
        except SystemExit as exc:  # argparse / explicit sys.exit
            code = exc.code if isinstance(exc.code, int) else 1
    return code, out.getvalue()


class DiagnoseTest(unittest.TestCase):
    def test_healthy_house_needs_nothing(self):
        with serving(FakeHouse(down=0, host=NEW_HOST)) as url:
            code, out = run_cli(url, "diagnose")
        self.assertEqual(code, 0)
        self.assertIn("Control4 is up", out)
        self.assertIn(f"0/{len(LIGHTS)}", out)

    def test_names_the_drift_and_the_command_that_fixes_it(self):
        with serving(FakeHouse(host=OLD_HOST, observed=NEW_HOST)) as url:
            code, out = run_cli(url, "diagnose")
        self.assertIn(f"{OLD_HOST} -> {NEW_HOST}", out)
        self.assertIn(f"repoint --ip {NEW_HOST}", out)

    def test_house_wide_outage_without_drift_reads_as_reload_first(self):
        with serving(FakeHouse(host=OLD_HOST, observed=OLD_HOST)) as url:
            code, out = run_cli(url, "diagnose")
        self.assertIn("down house-wide", out)
        self.assertIn("recover --yes", out)

    def test_a_few_dead_lights_is_not_an_integration_outage(self):
        with serving(FakeHouse(down=1, host=OLD_HOST, observed=OLD_HOST)) as url:
            code, out = run_cli(url, "diagnose")
        self.assertIn("partial fault", out)

    def test_a_partial_fault_reads_as_partial_even_when_addresses_disagree(self):
        with serving(FakeHouse(down=1, host=OLD_HOST, observed=NEW_HOST)) as url:
            code, out = run_cli(url, "diagnose")
        self.assertIn("partial fault", out)
        self.assertIn("also disagree", out)

    def test_a_handful_of_stragglers_is_still_a_house_wide_outage(self):
        """The entity map can carry a row the integration no longer owns; one
        stale light must not read as "partial" and block a real recovery."""
        with serving(FakeHouse(down=len(LIGHTS) - 3, host=OLD_HOST,
                               observed=OLD_HOST)) as url:
            code, out = run_cli(url, "diagnose")
        self.assertIn("down house-wide", out)

    def test_a_working_house_with_disagreeing_sensors_is_not_touched(self):
        with serving(FakeHouse(down=0, host=OLD_HOST, observed=NEW_HOST)) as url:
            code, out = run_cli(url, "diagnose")
        self.assertIn("Control4 is up", out)
        self.assertIn("disagree", out)
        self.assertNotIn("VERDICT: the Core 3 moved", out)

    def test_falls_back_to_the_error_log_when_the_host_sensor_is_absent(self):
        """The guardrail's host sensor is new; the integration has always
        named the stale host in its own setup error."""
        house = FakeHouse(host=OLD_HOST, observed=NEW_HOST)
        real_states = house.states
        house.states = lambda: [s for s in real_states()
                                if s["entity_id"] != c4.HOST_SENSOR]
        with serving(house) as url:
            code, out = run_cli(url, "diagnose")
        self.assertIn("[error log]", out)
        self.assertIn(f"{OLD_HOST} -> {NEW_HOST}", out)

    def test_diagnose_changes_nothing(self):
        house = FakeHouse()
        with serving(house) as url:
            run_cli(url, "diagnose")
        self.assertEqual(house.calls, [])


class RecoverTest(unittest.TestCase):
    def test_dry_run_by_default(self):
        house = FakeHouse(host=OLD_HOST, observed=OLD_HOST)
        with serving(house) as url:
            code, out = run_cli(url, "recover")
        self.assertIn("Dry run", out)
        self.assertEqual(house.calls, [])

    def test_reload_alone_fixes_fault_one(self):
        house = FakeHouse(host=OLD_HOST, observed=OLD_HOST, reload_fixes=True)
        with serving(house) as url:
            code, out = run_cli(url, "recover", "--yes")
        self.assertEqual(code, 0)
        self.assertIn("Recovered by reload", out)
        self.assertEqual([(d, s) for d, s, _ in house.calls],
                         [("homeassistant", "reload_config_entry")])

    def test_drift_goes_straight_to_the_repoint(self):
        """A reload cannot fix a moved controller, so it isn't attempted."""
        house = FakeHouse(host=OLD_HOST, observed=NEW_HOST)
        with serving(house) as url:
            code, out = run_cli(url, "recover", "--yes")
        self.assertEqual(code, 0)
        self.assertIn("Recovered by repoint", out)
        self.assertEqual(house.host, NEW_HOST)
        self.assertEqual([(d, s) for d, s, _ in house.calls],
                         [("shell_command", "c4_repoint"), ("homeassistant", "restart")])
        # Nothing caller-controlled reaches the shell_command: the service
        # resolves the controller by MAC itself (Codex review, PR #101).
        self.assertEqual(house.calls[0][2], {})

    def test_reload_that_uncovers_a_drift_then_repoints(self):
        """The 2026-08-12 sequence exactly: the reload gets past cloud auth
        and its own timeout is what reveals the new address."""
        house = FakeHouse(host=OLD_HOST, observed=OLD_HOST)

        def reveal(domain, service, data):
            if (domain, service) == ("homeassistant", "reload_config_entry"):
                house.observed = NEW_HOST  # the drift sensor catches up
            return FakeHouse.service(house, domain, service, data)

        house.service = reveal
        with serving(house) as url:
            code, out = run_cli(url, "recover", "--yes")
        self.assertEqual(code, 0)
        self.assertEqual(house.host, NEW_HOST)
        self.assertIn("Recovered by repoint", out)

    def test_a_clobbered_write_is_retried_once(self):
        """Home Assistant holds config entries in memory and saves .storage on
        its own schedule — the reason the manual fix needed two boots."""
        house = FakeHouse(host=OLD_HOST, observed=NEW_HOST, clobber_writes=1)
        with serving(house) as url:
            code, out = run_cli(url, "recover", "--yes")
        self.assertEqual(code, 0)
        self.assertEqual(house.host, NEW_HOST)
        self.assertEqual(sum(1 for d, s, _ in house.calls if s == "restart"), 2)

    def test_landing_on_a_third_address_stops_rather_than_rewriting(self):
        """The service points at whatever owns the MAC. If that turns out to
        be somewhere neither expected nor previous, retrying just writes it
        again — say so instead."""
        house = FakeHouse(host=OLD_HOST, observed="10.0.0.77", controller_at=NEW_HOST)
        with serving(house) as url:
            code, out = run_cli(url, "repoint", "--ip", NEW_HOST, "--yes")
        self.assertEqual(code, 1)
        self.assertIn("landed on 10.0.0.77", out)
        self.assertEqual(sum(1 for _, s, _ in house.calls if s == "c4_repoint"), 1)

    def test_without_the_shell_command_it_prints_the_by_hand_procedure(self):
        house = FakeHouse(host=OLD_HOST, observed=NEW_HOST, has_shell_command=False)
        with serving(house) as url:
            code, out = run_cli(url, "recover", "--yes")
        self.assertEqual(code, 1)
        self.assertIn("File editor", out)
        self.assertIn(NEW_HOST, out)
        self.assertIn("TWICE", out)
        self.assertNotIn("restart", [s for _, s, _ in house.calls])

    def test_no_observed_ip_refuses_rather_than_guessing(self):
        house = FakeHouse(host=OLD_HOST, observed=None)
        with serving(house) as url:
            code, out = run_cli(url, "recover", "--yes")
        self.assertEqual(code, 2)
        self.assertIn("Nmap Tracker", out)
        self.assertNotIn("c4_repoint", [s for _, s, _ in house.calls])

    def test_right_address_but_still_down_is_not_a_drift_problem(self):
        house = FakeHouse(host=OLD_HOST, observed=OLD_HOST)
        with serving(house) as url:
            code, out = run_cli(url, "recover", "--yes")
        self.assertEqual(code, 2)
        self.assertIn("not an IP drift", out)
        self.assertIn("native Control4 app", out)

    def test_refuses_a_partial_fault_rather_than_reloading_the_house(self):
        """diagnose says "look at those devices"; recover must not then reload
        the whole integration behind its own advice."""
        house = FakeHouse(down=1, host=OLD_HOST, observed=NEW_HOST)
        with serving(house) as url:
            code, out = run_cli(url, "recover", "--yes")
        self.assertEqual(code, 2)
        self.assertIn("partial fault", out)
        self.assertEqual(house.calls, [])

    def test_force_overrides_the_partial_refusal(self):
        house = FakeHouse(down=1, host=OLD_HOST, observed=NEW_HOST)
        with serving(house) as url:
            code, out = run_cli(url, "recover", "--yes", "--force")
        self.assertEqual(code, 0)
        self.assertEqual(house.host, NEW_HOST)

    def test_a_healthy_house_is_left_alone(self):
        house = FakeHouse(down=0, host=NEW_HOST, observed=NEW_HOST)
        with serving(house) as url:
            code, out = run_cli(url, "recover", "--yes")
        self.assertEqual(code, 0)
        self.assertEqual(house.calls, [])


class RepointScriptTest(unittest.TestCase):
    """ha/c4_repoint.py — the one thing here that writes to .storage."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.store = os.path.join(self.dir, "core.config_entries")
        self.write({
            "version": 1, "minor_version": 1, "key": "core.config_entries",
            "data": {"entries": [
                {"entry_id": "aaa", "domain": "coolmaster",
                 "data": {"host": "10.0.0.90", "port": 10102}},
                {"entry_id": ENTRY_ID, "domain": "control4",
                 "data": {"host": OLD_HOST, "username": "owner@example.com",
                          "password": "secret"}},
            ]},
        })
        repoint.STORE = self.store

    def write(self, payload):
        with open(self.store, "w") as handle:
            json.dump(payload, handle)

    def read(self):
        with open(self.store) as handle:
            return json.load(handle)

    def run_it(self, *args):
        out = io.StringIO()
        with mock.patch.object(sys, "argv", ["c4_repoint.py", *args]), \
             contextlib.redirect_stdout(out):
            return repoint.main(), out.getvalue()

    def test_finds_the_controller_by_mac_and_points_at_it(self):
        """How the shell_command invokes it: no caller input at all, so
        nothing a service caller sends can reach a shell."""
        with mock.patch.object(repoint, "resolve", return_value=(NEW_HOST, None)):
            code, out = self.run_it("--mac", "00:0f:ff:9f:3b:44")
        self.assertEqual(code, 0)
        self.assertEqual(self.entry()["data"]["host"], NEW_HOST)
        self.assertIn(f"{OLD_HOST} -> {NEW_HOST}", out)

    def test_a_mac_that_does_not_answer_changes_nothing(self):
        with mock.patch.object(repoint, "resolve", return_value=(None, "no answer")):
            code, out = self.run_it("--mac", "00:0f:ff:9f:3b:44")
        self.assertEqual(code, 1)
        self.assertIn("refused", out)
        self.assertEqual(self.entry()["data"]["host"], OLD_HOST)

    def test_wants_exactly_one_of_host_or_mac(self):
        for args in ((), (NEW_HOST, "--mac", "00:0f:ff:9f:3b:44")):
            code, out = self.run_it(*args)
            self.assertEqual(code, 1, args)
            self.assertIn("exactly one", out)
        self.assertEqual(self.entry()["data"]["host"], OLD_HOST)

    def test_a_resolved_address_is_validated_too(self):
        """The scan reads /proc/net/arp; a garbled line must not be written."""
        with mock.patch.object(repoint, "resolve", return_value=("not-an-ip", None)):
            code, out = self.run_it("--mac", "00:0f:ff:9f:3b:44")
        self.assertEqual(code, 1)
        self.assertIn("refused", out)
        self.assertEqual(self.entry()["data"]["host"], OLD_HOST)

    def entry(self, domain="control4"):
        return next(e for e in self.read()["data"]["entries"] if e["domain"] == domain)

    def test_rewrites_only_the_host(self):
        code, out = self.run_it(NEW_HOST)
        self.assertEqual(code, 0)
        self.assertEqual(self.entry()["data"]["host"], NEW_HOST)
        self.assertIn(f"{OLD_HOST} -> {NEW_HOST}", out)

    def test_keeps_the_credentials_and_every_other_entry(self):
        """Losing these is exactly what delete-and-re-add would cost."""
        self.run_it(NEW_HOST)
        self.assertEqual(self.entry()["data"]["username"], "owner@example.com")
        self.assertEqual(self.entry()["data"]["password"], "secret")
        self.assertEqual(self.entry("coolmaster")["data"]["host"], "10.0.0.90")
        self.assertEqual(self.read()["version"], 1)
        self.assertEqual(self.read()["key"], "core.config_entries")

    def test_leaves_a_backup(self):
        self.run_it(NEW_HOST)
        backups = [f for f in os.listdir(self.dir) if ".bak-" in f]
        self.assertEqual(len(backups), 1)
        with open(os.path.join(self.dir, backups[0])) as handle:
            self.assertEqual(json.load(handle)["data"]["entries"][1]["data"]["host"],
                             OLD_HOST)

    def test_already_correct_is_a_no_op_success(self):
        code, out = self.run_it(OLD_HOST)
        self.assertEqual(code, 0)
        self.assertIn("unchanged", out)
        self.assertEqual([f for f in os.listdir(self.dir) if ".bak-" in f], [])

    def test_refuses_anything_that_is_not_an_address(self):
        # "10.0.0.1; …" is the shell-injection payload the service can no
        # longer carry (Codex review, PR #101). Defence in depth: even reached
        # by hand, the script writes nothing.
        for bad in ("", "10.0.0", "999.1.1.1", "10.0.0.1; rm -rf /", "localhost",
                    "$(id)", "10.0.0.1 && curl evil"):
            code, out = self.run_it(bad)
            self.assertEqual(code, 1, bad)
            self.assertIn("refused", out)
            self.assertEqual(self.entry()["data"]["host"], OLD_HOST)

    def test_refuses_an_ambiguous_or_absent_entry(self):
        store = self.read()
        store["data"]["entries"].append(
            {"entry_id": "dup", "domain": "control4", "data": {"host": "10.0.0.7"}})
        self.write(store)
        code, out = self.run_it(NEW_HOST)
        self.assertEqual(code, 1)
        self.assertIn("found 2", out)

    def test_refuses_a_store_it_does_not_recognise(self):
        self.write({"data": {"nope": []}})
        code, out = self.run_it(NEW_HOST)
        self.assertEqual(code, 1)
        self.assertIn("not shaped like", out)


class ScanScriptTest(unittest.TestCase):
    """ha/c4_scan.py — the MAC → IP lookup, without touching the network."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir)
        self.table = os.path.join(self.dir, "arp")
        scan.ARP_TABLE = self.table

    def write(self, body):
        with open(self.table, "w") as handle:
            handle.write("IP address       HW type     Flags       HW address"
                         "            Mask     Device\n" + body)

    def test_finds_the_controller(self):
        self.write("10.0.0.42        0x1         0x2         00:0f:ff:9f:3b:44"
                   "     *        end0\n")
        self.assertEqual(scan.arp_lookup("00:0f:ff:9f:3b:44"), "10.0.0.42")

    def test_ignores_other_hosts_and_unresolved_entries(self):
        self.write("10.0.0.90        0x1         0x2         00:11:22:33:44:55     *        end0\n"
                   "10.0.0.99        0x1         0x0         00:00:00:00:00:00     *        end0\n")
        self.assertIsNone(scan.arp_lookup("00:0f:ff:9f:3b:44"))

    def test_a_missing_table_is_unknown_not_a_crash(self):
        scan.ARP_TABLE = os.path.join(self.dir, "nope")
        self.assertIsNone(scan.arp_lookup("00:0f:ff:9f:3b:44"))

    def test_a_bad_mac_prints_unknown_and_never_sweeps(self):
        out = io.StringIO()
        with mock.patch.object(sys, "argv", ["c4_scan.py", "not-a-mac"]), \
             mock.patch.object(scan, "sweep") as sweeper, \
             contextlib.redirect_stdout(out):
            code = scan.main()
        self.assertEqual(code, 0)
        self.assertEqual(out.getvalue().strip(), "unknown")
        sweeper.assert_not_called()

    def test_sweeps_when_the_table_is_cold_then_reports(self):
        self.write("")
        rows = ["10.0.0.42        0x1         0x2         00:0f:ff:9f:3b:44     *        end0\n"]
        out = io.StringIO()
        with mock.patch.object(sys, "argv", ["c4_scan.py", "00:0F:FF:9F:3B:44"]), \
             mock.patch.object(scan, "sweep", side_effect=lambda p: self.write(rows[0])), \
             mock.patch("time.sleep"), contextlib.redirect_stdout(out):
            scan.main()
        self.assertEqual(out.getvalue().strip(), "10.0.0.42")


class RecoveryYamlTest(unittest.TestCase):
    """The service definition itself, since a template there is a shell."""

    def setUp(self):
        with open(os.path.join(ROOT, "ha", "c4_recovery.yaml")) as handle:
            self.text = handle.read()
        self.commands = {
            key: line.split(":", 1)[1].strip().strip('"')
            for line in self.text.splitlines()
            for key in ("c4_repoint", "cm_repoint")
            if line.strip().startswith(key + ":")
        }
        self.command = self.commands["c4_repoint"]

    def test_the_shell_command_carries_no_template(self):
        """Home Assistant runs a templated shell_command through a shell, so
        any {{ }} here is a command-execution hole for every service caller."""
        self.assertEqual(sorted(self.commands), ["c4_repoint", "cm_repoint"])
        for name, command in self.commands.items():
            self.assertNotIn("{{", command, name)
            self.assertNotIn("{%", command, name)

    def test_it_resolves_the_controller_by_mac_instead(self):
        self.assertIn("--mac", self.command)
        self.assertIn(c4.CORE3_MAC, self.command)

    def test_the_coolmaster_service_is_the_same_fixed_argv_for_its_own_entry(self):
        """Second device, same rule: the service names its config entry and
        its MAC and takes nothing from the caller."""
        command = self.commands["cm_repoint"]
        self.assertIn("--domain coolmaster", command)
        self.assertIn("--mac 28:3b:96:11:60:51", command)


class SelfHealYamlTest(unittest.TestCase):
    """The self-heal automations act unattended: they reload a config entry,
    rewrite `.storage` and restart the house. These are the conditions that
    keep that from happening on anything except the one fault it is for."""

    @classmethod
    def setUpClass(cls):
        if yaml is None:
            raise unittest.SkipTest("pyyaml not installed")
        with open(os.path.join(ROOT, "ha", "c4_recovery.yaml")) as handle:
            cls.doc = yaml.safe_load(handle)
        autos = []
        for key, value in cls.doc.items():
            if key.split()[0] == "automation":
                autos.extend(value)
        cls.autos = {a["id"]: a for a in autos}

    def conditions(self, automation_id):
        return json.dumps(self.autos[automation_id].get("condition", []))

    REPOINTS = {"c4_auto_repoint": "c4", "cm_auto_repoint": "cm"}
    ACTORS = ("c4_reload_after_boot", "c4_auto_repoint", "cm_auto_repoint", "cm_after_boot")

    def test_every_self_heal_automation_is_gated_on_the_kill_switch(self):
        """One toggle in the app has to be able to stop all of this."""
        for auto_id in self.ACTORS:
            self.assertIn("input_boolean.c4_self_heal", self.conditions(auto_id), auto_id)

    def test_the_repoint_refuses_anything_short_of_a_house_wide_outage(self):
        """A partial fault plus a stale scan must not restart the house — the
        same line tools/c4_recover.py refuses without --force."""
        for auto_id in self.REPOINTS:
            self.assertIn(">= 0.8", self.conditions(auto_id), auto_id)

    def test_the_repoint_is_rate_limited_across_restarts(self):
        """Without this, a controller answering ARP at an address it cannot
        actually be reached on rewrites and reboots forever."""
        for auto_id, prefix in self.REPOINTS.items():
            conditions = self.conditions(auto_id)
            self.assertIn(f"input_datetime.{prefix}_last_auto_repoint", conditions, auto_id)
            self.assertIn("21600", conditions, auto_id)
            stamp = json.dumps(self.autos[auto_id]["action"][0])
            self.assertIn("input_datetime.set_datetime", stamp,
                          "the window must be burned before the restart, not after")

    def hold(self, automation_id):
        held = self.autos[automation_id]["trigger"][0]["for"]
        hours, minutes, seconds = (int(p) for p in held.split(":"))
        return hours * 3600 + minutes * 60 + seconds

    def test_the_repoint_waits_out_the_reload_before_it_acts(self):
        """Overlap would restart the house in the middle of a recovery that
        was about to work on its own."""
        reload_budget = 3 * 60 + 3 * 8 * 60      # settle + three attempts
        for auto_id in self.REPOINTS:
            self.assertGreater(self.hold(auto_id), reload_budget, auto_id)

    def test_the_two_repoints_can_never_fire_together(self):
        """Two rewrites racing to restart the house would lose one of them:
        the CoolMaster repoint holds longer AND stands down while the Core 3
        is drifted, so the Control4 one always goes first."""
        self.assertGreater(self.hold("cm_auto_repoint"), self.hold("c4_auto_repoint"))
        gate = next(c for c in self.autos["cm_auto_repoint"]["condition"]
                    if c.get("entity_id") == "binary_sensor.c4_ip_drift")
        self.assertEqual(gate["state"], "off")

    def test_the_repoint_only_restarts_when_the_rewrite_succeeded(self):
        for auto_id in self.REPOINTS:
            branch = next(a for a in self.autos[auto_id]["action"] if "if" in a)
            self.assertIn("returncode == 0", json.dumps(branch["if"]), auto_id)
            self.assertIn("homeassistant.restart", json.dumps(branch["then"]), auto_id)
            self.assertNotIn("homeassistant.restart", json.dumps(branch["else"]), auto_id)

    def test_the_reload_cannot_index_an_empty_entity_list(self):
        """The reload target is `integration_entities('control4') | first`; on
        a rebuilt Green that list is empty and `first` would raise."""
        self.assertIn("count > 0", self.conditions("c4_reload_after_boot"))

    def test_the_reload_refreshes_the_address_sensors_before_anything_reads_them(self):
        """A 12-hour scan_interval means a post-boot reading can be hours old,
        or empty from a scan that ran while the network was coming up."""
        actions = json.dumps(self.autos["c4_reload_after_boot"]["action"])
        self.assertIn("homeassistant.update_entity", actions)
        self.assertIn("sensor.c4_ip_watch", actions)

    def branch(self):
        """The reload automation's health fork: (healthy sequence, default)."""
        chosen = next(a for a in self.autos["c4_reload_after_boot"]["action"]
                      if "choose" in a)
        return chosen["choose"][0], chosen["default"]

    def test_the_reload_leaves_a_healthy_house_alone(self):
        """A reload blips all 179 devices and spends a Control4 cloud auth
        call, so the retry loop must be unreachable on a routine restart."""
        healthy, default = self.branch()
        self.assertIn("< 0.8", json.dumps(healthy["conditions"]))
        self.assertNotIn("reload_config_entry", json.dumps(healthy["sequence"]))
        self.assertIn("reload_config_entry", json.dumps(default))

    def test_the_repoint_claims_nothing_before_it_has_rewritten_anything(self):
        """The runbook sends a reader to these notifications to decide whether
        the house is fixed. One that says so before `c4_repoint.py` has even
        run stops the troubleshooting of a house that is still down."""
        for auto_id, prefix in self.REPOINTS.items():
            actions = self.autos[auto_id]["action"]
            shell_at = next(i for i, a in enumerate(actions)
                            if a.get("action") == f"shell_command.{prefix}_repoint")
            before = json.dumps(actions[:shell_at])
            for claim in ("repointed automatically", "Restarting HA", "is back"):
                self.assertNotIn(claim, before, auto_id)
            self.assertIn("repointing now", before.lower(),
                          "the attempt still has to be announced")

    def test_a_failed_repoint_corrects_the_phone_not_just_the_dashboard(self):
        """A persistent notification can be replaced by id; a push cannot, so
        without a second push the phone keeps the optimistic one."""
        for auto_id in self.REPOINTS:
            branch = next(a for a in self.autos[auto_id]["action"] if "if" in a)
            pushed = [a for a in branch["else"] if a["action"].startswith("notify.")]
            self.assertTrue(pushed, "failure never reaches the phone")
            self.assertEqual(pushed[0]["data"]["data"]["tag"], auto_id,
                             "without a shared tag it stacks instead of replacing")

    def test_a_coolmaster_repoint_is_confirmed_after_the_restart(self):
        """Same rule as Control4: the repoint script never returns, so the only
        place its outcome can be reported from is the boot that follows."""
        blob = json.dumps(self.autos["cm_after_boot"]["action"])
        self.assertIn("cm_last_auto_repoint", blob)
        self.assertIn("CoolMaster is back", blob)
        self.assertIn("did not come back", blob)
        self.assertIn('"tag": "cm_auto_repoint"', blob)

    def test_the_coolmaster_refresh_runs_on_every_boot_not_only_after_a_repoint(self):
        """A 12-hour scan that ran while the network was still coming up would
        otherwise hide a drift until the afternoon (2026-08-21). The stamp
        check gates only the report, not the refresh."""
        self.assertNotIn("cm_last_auto_repoint", self.conditions("cm_after_boot"))
        actions = self.autos["cm_after_boot"]["action"]
        refresh_at = next(i for i, a in enumerate(actions)
                          if a.get("action") == "homeassistant.update_entity")
        self.assertIn("sensor.cm_ip_watch", json.dumps(actions[refresh_at]))
        gate_at = next(i for i, a in enumerate(actions)
                       if "cm_last_auto_repoint" in json.dumps(a))
        self.assertGreater(gate_at, refresh_at)

    def test_a_successful_repoint_is_confirmed_after_the_restart(self):
        """`homeassistant.restart` ends that script, and persistent
        notifications do not survive it — so the only place success can be
        reported from is the automation that runs on the next boot."""
        healthy, _ = self.branch()
        blob = json.dumps(healthy["sequence"])
        self.assertIn("c4_last_auto_repoint", json.dumps(
            self.autos["c4_reload_after_boot"]["action"]))
        self.assertIn("after_repoint", blob)
        self.assertIn("Control4 is back", blob)

    def test_no_template_can_divide_by_an_empty_entity_list(self):
        """`ents | count` is a divisor in four places; on a rebuilt Green it
        is zero and the whole automation dies on a template error."""
        blob = "".join(json.dumps(self.autos[a]) for a in self.ACTORS)
        for fragment in blob.split("/ (ents | count)")[:-1]:
            tail = fragment[-260:]
            self.assertTrue(
                "count > 0" in tail or "count == 0" in tail,
                "unguarded division:" + tail)

    def test_every_automation_id_is_unique(self):
        self.assertEqual(len(self.autos), 6)


class HelperTest(unittest.TestCase):
    def test_outage_verdict_separates_a_dead_device_from_a_dead_integration(self):
        self.assertEqual(c4.outage_verdict(0, 144), "healthy")
        self.assertEqual(c4.outage_verdict(1, 144), "partial")
        self.assertEqual(c4.outage_verdict(70, 144), "partial")
        self.assertEqual(c4.outage_verdict(140, 144), "house-wide")
        self.assertEqual(c4.outage_verdict(144, 144), "house-wide")
        self.assertEqual(c4.outage_verdict(0, 0), "unknown")

    def test_valid_ip(self):
        self.assertTrue(c4.valid_ip("10.0.0.33"))
        for bad in ("10.0.0.256", "10.0.0", "", None, "ten.zero.zero.one"):
            self.assertFalse(c4.valid_ip(bad), bad)

    def test_the_entity_map_still_carries_the_control4_lights(self):
        """If this ever empties, `health` silently starts measuring nothing."""
        self.assertGreater(len(LIGHTS), 100)
        self.assertTrue(all(e.startswith("light.") for e in LIGHTS))

    def test_reads_the_stale_host_out_of_the_integration_error(self):
        log = ("ERROR (MainThread) [homeassistant.config_entries] Config entry for "
               "control4 not ready yet: Timeout connecting to Control4 controller "
               "at 10.0.0.29\n")
        self.assertEqual(c4.LOG_HOST.findall(log), ["10.0.0.29"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
