"""Package a built app without symlinks, retaining executable Unix modes."""
import hashlib,json,os,stat,sys,zipfile
from pathlib import Path
bundle=Path(sys.argv[1]).resolve()
assert bundle.name=='CMCP.app' and bundle.is_dir()
manifest=json.loads((bundle/'Contents/Resources/distribution-manifest.json').read_text(encoding='utf-8'))
output=Path(sys.argv[2]).resolve();output.mkdir(parents=True,exist_ok=True)
filename=output/('CMCP-'+manifest['version']+'-'+manifest['platform']+'.zip')
if filename.exists():raise RuntimeError('Refusing to overwrite package')
with zipfile.ZipFile(filename,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
    for file in sorted(bundle.rglob('*')):
        if file.is_symlink():raise RuntimeError('Symlink in application')
        if not file.is_file():continue
        relative=file.relative_to(bundle).as_posix()
        item=zipfile.ZipInfo('CMCP.app/'+relative)
        item.create_system=3;item.compress_type=zipfile.ZIP_DEFLATED
        mode=stat.S_IMODE(file.stat().st_mode)
        item.external_attr=(stat.S_IFREG|mode)<<16
        archive.writestr(item,file.read_bytes())
digest=hashlib.sha256(filename.read_bytes()).hexdigest()
Path(str(filename)+'.sha256').write_text(digest+'  '+filename.name+'\n',encoding='ascii')
print(json.dumps({'file':str(filename),'sha256':digest,'bytes':filename.stat().st_size}))
