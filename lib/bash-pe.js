/** Strict PE import redirection, never patch executable instructions or original package bytes. */
export function patchMsys(bytes) {
  const b = Buffer.from(bytes)
  if (b.toString('ascii',0,2) !== 'MZ') throw Error('Expected PE')
  const pe=b.readUInt32LE(60), optional=pe+24
  if(b.readUInt32LE(pe)!==0x4550 || b.readUInt16LE(pe+4)!==0x8664 || b.readUInt16LE(optional)!==0x20b) throw Error('Expected x64 PE32+')
  const section=optional+b.readUInt16LE(pe+20), sections=[]
  for(let i=0;i<b.readUInt16LE(pe+6);i++) { const at=section+40*i; sections.push({rva:b.readUInt32LE(at+12),size:Math.max(b.readUInt32LE(at+8),b.readUInt32LE(at+16)),raw:b.readUInt32LE(at+20)}) }
  const off=r=>{const s=sections.find(s=>r>=s.rva&&r<s.rva+s.size);if(!s)throw Error('PE RVA outside sections');return r-s.rva+s.raw}
  const string=r=>{const at=off(r),end=b.indexOf(0,at);if(end<0||end-at>256)throw Error('Invalid PE import name');return b.toString('ascii',at,end)}
  const exports={}
  let table=off(b.readUInt32LE(optional+120))
  for(let count=0;b.readUInt32LE(table+12);count++,table+=20) {
    if(count>64)throw Error('PE import limit')
    const name=string(b.readUInt32LE(table+12)).toLowerCase()
    if(!['kernel32.dll','ntdll.dll'].includes(name))continue
    const names=[];let thunk=off(b.readUInt32LE(table)||b.readUInt32LE(table+16))
    for(let n=0;b.readBigUInt64LE(thunk);n++,thunk+=8){if(n>1024)throw Error('PE thunk limit');const value=b.readBigUInt64LE(thunk);if(value>=0x8000000000000000n)throw Error('Ordinal imports unsupported');names.push(string(Number(value)+2))}
    exports[name]=names
    const at=off(b.readUInt32LE(table+12));b.fill(0,at,at+name.length);b.write(name==='kernel32.dll'?'opsipc.dll':'opsnt.dll',at,'ascii')
  }
  if(!exports['kernel32.dll']?.includes('CreateNamedPipeA')||!exports['ntdll.dll']?.includes('NtCreateNamedPipeFile'))throw Error('Unexpected MSYS imports')
  return {bytes:b,exports}
}
export function proxyDefinition(names, dll) {
  const overrides=dll==='kernel32.dll'?['CreateNamedPipeA','CreatePipe','IdnToAscii','IdnToUnicode']:['NtCreateNamedPipeFile','NtCreateSection']
  return `LIBRARY ${dll==='kernel32.dll'?'opsipc':'opsnt'}\nEXPORTS\n`+names.map(n=>` ${n}=${overrides.includes(n)?'Ops'+n:(dll==='kernel32.dll'?'KERNEL32.':'NTDLL.')+n}`).join('\n')+'\n'
}
