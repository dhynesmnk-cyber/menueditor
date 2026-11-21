"""What ascent/descent does the font actually declare? Chrome may use hhea or
OS/2, and canvas fontBoundingBox reports whichever Skia picked. Compare."""
import struct
import sys

def tables(data):
    num = struct.unpack('>H', data[4:6])[0]
    out = {}
    for i in range(num):
        off = 12 + i * 16
        tag = data[off:off + 4].decode('latin-1')
        ptr, ln = struct.unpack('>II', data[off + 8:off + 16])
        out[tag] = (ptr, ln)
    return out

def analyze(path):
    d = open(path, 'rb').read()
    t = tables(d)
    head = t['head'][0]
    upem = struct.unpack('>H', d[head + 18:head + 20])[0]
    hhea = t['hhea'][0]
    ha, hd, hl = struct.unpack('>hhh', d[hhea + 4:hhea + 10])
    res = {'file': path.split('/')[-1], 'upem': upem, 'hhea': (ha, hd, hl)}
    if 'OS/2' in t:
        o = t['OS/2'][0]
        ver = struct.unpack('>H', d[o:o + 2])[0]
        ta, td, tg = struct.unpack('>hhh', d[o + 68:o + 74])
        wa, wd = struct.unpack('>HH', d[o + 74:o + 78])
        fs = struct.unpack('>H', d[o + 62:o + 64])[0]
        res['typo'] = (ta, td, tg)
        res['win'] = (wa, wd)
        res['useTypo'] = bool(fs & (1 << 7))
        res['os2ver'] = ver
    return res

for p in sys.argv[1:]:
    r = analyze(p)
    u = r['upem']
    ha, hd, _ = r['hhea']
    A_h, D_h = ha / u, -hd / u
    print(f"\n{r['file']}  upem={u}")
    print(f"  hhea   asc/desc: {ha:6d}/{hd:6d}  -> A={A_h:.4f} D={D_h:.4f}  A+D={A_h+D_h:.4f}")
    if 'typo' in r:
        ta, td, _ = r['typo']
        wa, wd = r['win']
        print(f"  typo   asc/desc: {ta:6d}/{td:6d}  -> A={ta/u:.4f} D={-td/u:.4f}  A+D={(ta-td)/u:.4f}")
        print(f"  win    asc/desc: {wa:6d}/{wd:6d}  -> A={wa/u:.4f} D={wd/u:.4f}  A+D={(wa+wd)/u:.4f}")
        print(f"  USE_TYPO_METRICS bit: {r['useTypo']}")
    def baseline(A, D):
        return (1 - (A + D)) / 2 + A
    print(f"  line-box baseline (hhea): {baseline(A_h, D_h):.4f} em")
    if 'typo' in r:
        print(f"  line-box baseline (typo): {baseline(ta/u, -td/u):.4f} em")
        print(f"  line-box baseline (win):  {baseline(wa/u, wd/u):.4f} em")
