import socket, struct, sys

# find local IP on the LAN
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.connect(('10.0.0.69', 8123))
local_ip = s.getsockname()[0]
s.close()
print(f'local ip: {local_ip}')

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind((local_ip, 0))
port = sock.getsockname()[1]
sock.settimeout(4)

# KNXnet/IP SEARCH_REQUEST
hpai = b'\x08\x01' + socket.inet_aton(local_ip) + struct.pack('!H', port)
frame = b'\x06\x10\x02\x01' + struct.pack('!H', 6 + len(hpai)) + hpai
sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 4)
sock.sendto(frame, ('224.0.23.12', 3671))

found = False
try:
    while True:
        data, addr = sock.recvfrom(1024)
        found = True
        print(f'\nRESPONSE from {addr[0]}:{addr[1]} ({len(data)} bytes)')
        # parse DIBs after 6-byte header + HPAI
        try:
            hpai_len = data[6]
            i = 6 + hpai_len
            while i < len(data):
                dl, dt = data[i], data[i+1]
                if dl == 0: break
                body = data[i+2:i+dl]
                if dt == 0x01:  # device info
                    medium, status = body[0], body[1]
                    knx_addr = struct.unpack('!H', body[2:4])[0]
                    serial = body[6:12].hex()
                    mac = body[16:22].hex(':')
                    name = body[22:52].split(b'\x00')[0].decode('latin1', 'replace')
                    print(f'  device: "{name}" | KNX addr {knx_addr>>12}.{(knx_addr>>8)&0xF}.{knx_addr&0xFF} | medium=0x{medium:02x} status=0x{status:02x}')
                    print(f'  serial {serial} | mac {mac}')
                elif dt == 0x02:  # supported services
                    svcs = {2:'Core',3:'DevMgmt',4:'Tunnelling',5:'Routing',6:'RemoteLog',8:'ObjSrv',9:'Security'}
                    got = [svcs.get(body[j], hex(body[j])) + f' v{body[j+1]}' for j in range(0, len(body), 2)]
                    print(f'  services: {", ".join(got)}')
                i += dl
        except Exception as e:
            print(f'  (parse error {e}; raw: {data.hex()})')
except socket.timeout:
    pass
if not found:
    print('\nno KNXnet/IP gateway responded to multicast search')
