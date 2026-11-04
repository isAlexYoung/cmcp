"""Package a built app as the update zip (no symlinks, executable Unix modes kept) and the drag-to-install disk image."""
import hashlib,json,stat,subprocess,sys,tempfile,time,zipfile
from pathlib import Path
bundle=Path(sys.argv[1]).resolve()
assert bundle.name=='CMCP.app' and bundle.is_dir()
manifest=json.loads((bundle/'Contents/Resources/distribution-manifest.json').read_text(encoding='utf-8'))
output=Path(sys.argv[2]).resolve();output.mkdir(parents=True,exist_ok=True)
stem='CMCP-'+manifest['version']+'-'+manifest['platform']
filename=output/(stem+'.zip')
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
def checksum(file):
    digest=hashlib.sha256(file.read_bytes()).hexdigest()
    Path(str(file)+'.sha256').write_text(digest+'  '+file.name+'\n',encoding='ascii')
    return digest
digest=checksum(filename)
result={'file':str(filename),'sha256':digest,'bytes':filename.stat().st_size}
if '--zip-only' not in sys.argv[3:]:
    image=output/(stem+'.dmg')
    if image.exists():raise RuntimeError('Refusing to overwrite package')
    with tempfile.TemporaryDirectory() as temporary:
        stage=Path(temporary)/'CMCP';stage.mkdir()
        subprocess.run(['/usr/bin/ditto',str(bundle),str(stage/'CMCP.app')],check=True)
        (stage/'Applications').symlink_to('/Applications')
        # hdiutil sometimes reports "Resource busy" on a busy machine; a later attempt succeeds.
        for attempt in range(5):
            if subprocess.run(['/usr/bin/hdiutil','create','-volname','CMCP','-srcfolder',str(stage),'-fs','HFS+','-format','UDZO',str(image)]).returncode==0:break
            image.unlink(missing_ok=True);time.sleep(5)
        else:raise RuntimeError('hdiutil could not create the disk image')
    subprocess.run(['/usr/bin/hdiutil','verify',str(image)],check=True)
    result.update(image=str(image),imageSha256=checksum(image),imageBytes=image.stat().st_size)
print(json.dumps(result))
