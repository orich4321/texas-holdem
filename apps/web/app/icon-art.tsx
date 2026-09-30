export function IconArt({ pixels }: { pixels: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: pixels, height: pixels, borderRadius: pixels * .23, background: '#0d221a' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: pixels * .69, height: pixels * .78, border: `${Math.max(2, pixels * .025)}px solid #b89b65`, borderRadius: pixels * .1, background: '#f1ede1' }}>
        <span style={{ color: '#173b2b', fontFamily: 'Georgia, serif', fontSize: pixels * .64, lineHeight: 1 }}>♠</span>
      </div>
    </div>
  );
}
