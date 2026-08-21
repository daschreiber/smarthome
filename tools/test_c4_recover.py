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

    `lights_up` is the only thing that matters to the caller; the fake moves
    it exactly when the real one would — on a reload that gets past cloud
    auth, or on a restart once the entry's host finally matches where the
    controller answers.
    """

    def __init__(self, *, lights_up=False, host=OLD_HOST, observed=NEW_HOST,
                 reload_fixes=False, has_shell_command=True, clobber_writes=0):
        self.lights_up = lights_up
        self.host = host
        self.observed = observed
        self.reload_fixes = reload_fixes
        self.has_shell_command = has_shell_command
        self.clobber_writes = clobber_writes  # HA saving .storage over our edit
        self.calls = []

    def service(self, domain, service, data):
        self.calls.append((domain, service, data))
        if (domain, service) == ("homeassistant", "reload_config_entry"):
            if self.reload_fixes:
                self.lights_up = True
            return 200, "[]"
        if (domain, service) == ("shell_command", "c4_repoint"):
            if not self.has_shell_command:
                return 400, '{"message": "Service shell_command.c4_repoint not found"}'
            if self.clobber_writes > 0:
                self.clobber_writes -= 1  # write accepted, then lost to a save
                return 200, "[]"
            self.host = data.get("ip")
            return 200, "[]"
        if (domain, service) == ("homeassistant", "restart"):
            if self.host == self.observed:
                self.lights_up = True
            return 200, "[]"
        return 200, "[]"

    def states(self):
        out = [{"entity_id": e,
                "state": "off" if self.lights_up else "unavailable",
                "attributes": {}} for e in LIGHTS]
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
        with serving(FakeHouse(lights_up=True, host=NEW_HOST)) as url:
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
        house = FakeHouse(lights_up=True, host=OLD_HOST, observed=OLD_HOST)
        real_states = house.states
        house.states = lambda: [
            dict(s, state="unavailable") if s["entity_id"] == LIGHTS[0] else s
            for s in real_states()
        ]
        with serving(house) as url:
            code, out = run_cli(url, "diagnose")
        self.assertIn("partial fault", out)

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
        self.assertEqual(house.calls[0][2], {"ip": NEW_HOST})

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

    def test_a_healthy_house_is_left_alone(self):
        house = FakeHouse(lights_up=True, host=NEW_HOST)
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
        for bad in ("", "10.0.0", "999.1.1.1", "10.0.0.1; rm -rf /", "localhost"):
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


class HelperTest(unittest.TestCase):
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
