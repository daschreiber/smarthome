import socket, struct

GW = ('10.0.0.70', 3671)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.connect(GW)
local_ip, local_port = s.getsockname()
s.settimeout(4)
hpai = b'\x08\x01' + socket.inet_aton(local_ip) + struct.pack('!H', local_port)

# CONNECT_REQUEST (tunnelling, link-layer)
cri = b'\x04\x04\x02\x00'
req = b'\x06\x10\x02\x05' + struct.pack('!H', 6 + 16 + 4) + hpai + hpai + cri
s.send(req)
try:
    data = s.recv(1024)
except socket.timeout:
    print('no response to CONNECT_REQUEST (timeout)')
    raise SystemExit
if data[2:4] != b'\x02\x06':
    print('unexpected response:', data.hex()); raise SystemExit
channel, status = data[6], data[7]
codes = {0x00:'E_NO_ERROR (accepted)', 0x22:'E_CONNECTION_TYPE', 0x23:'E_CONNECTION_OPTION', 0x24:'E_NO_MORE_CONNECTIONS'}
print(f'CONNECT_RESPONSE: status=0x{status:02x} {codes.get(status,"?")} channel={channel}')
if status == 0x00:
    # got a slot -> at least 2 tunnels (C4 presumably holds one); release immediately
    disc = b'\x06\x10\x02\x09' + struct.pack('!H', 16) + bytes([channel, 0]) + hpai
    s.send(disc)
    try:
        d2 = s.recv(1024)
        print(f'DISCONNECT_RESPONSE: status=0x{d2[7]:02x}' if d2[2:4]==b'\x02\x0a' else f'reply: {d2.hex()}')
    except socket.timeout:
        print('disconnect: no reply (slot times out on its own in ~2min)')
