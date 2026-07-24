import re, sys

def dpt9(b):
    v = (b[0] << 8) | b[1]
    sign = -1 if v & 0x8000 else 1
    exp = (v >> 11) & 0xF
    mant = v & 0x7FF
    if sign < 0: mant = mant - 2048
    return round(mant * 0.01 * (2 ** exp), 2)

pat = re.compile(r'^(\S+ \S+) xknx\.raw_socket DEBUG Received.*: (06100420\w+)$')
for line in open(sys.argv[1]):
    m = pat.match(line.strip())
    if not m: continue
    ts, hexs = m.group(1), m.group(2)
    b = bytes.fromhex(hexs)
    # KNXIP header 6 + connection header 4, then cEMI
    cemi = b[10:]
    code = cemi[0]
    if code not in (0x29, 0x2e): continue  # L_DATA_IND / L_DATA_CON
    addil = cemi[1]
    f = cemi[2+addil:]
    src = (f[2] << 8) | f[3]
    dst = (f[4] << 8) | f[5]
    length = f[6]
    apci_hi, apci_lo = f[7], f[8]
    apci = ((apci_hi & 0x03) << 2) | (apci_lo >> 6)
    svc = {0:'READ', 1:'RESP', 2:'WRITE'}.get(apci, f'apci{apci}')
    if length == 1:
        val = f'{apci_lo & 0x3F}'
    else:
        data = f[9:9+length-1]
        val = data.hex()
        if len(data) == 1:
            val += f' ({data[0]}, {round(data[0]/2.55)}%)'
        elif len(data) == 2:
            val += f' (dpt9={dpt9(data)})'
    srcs = f'{src>>12}.{(src>>8)&0xF}.{src&0xFF}'
    dsts = f'{dst>>11}/{(dst>>8)&0x7}/{dst&0xFF}'
    kind = 'IND' if code == 0x29 else 'CON'
    print(f'{ts[11:]} {kind} {srcs:>9} -> {dsts:<9} {svc:<5} {val}')
