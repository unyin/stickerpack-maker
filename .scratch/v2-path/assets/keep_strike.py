"""Keep only the CBLC/CBDT strike(s) with the given ppem(s). Usage: keep_strike.py in.ttf out.ttf 96 [64 ...]"""
import sys
from fontTools.ttLib import TTFont
src, dst, keep = sys.argv[1], sys.argv[2], {int(x) for x in sys.argv[3:]}
f = TTFont(src)  # non-lazy so every table round-trips on save
cblc, cbdt = f['CBLC'], f['CBDT']
idx = [i for i, s in enumerate(cblc.strikes) if s.bitmapSizeTable.ppemY in keep]
assert idx, "no matching strike"
cblc.strikes = [cblc.strikes[i] for i in idx]
cbdt.strikeData = [cbdt.strikeData[i] for i in idx]
f.save(dst)
print("kept strikes", [cblc.strikes[i].bitmapSizeTable.ppemY for i in range(len(idx))])
