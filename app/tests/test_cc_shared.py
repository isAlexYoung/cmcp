"""CC shared-data descriptor models; never modifies Linux accounts or profiles."""
import importlib.util
import io
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]


def modules():
    for name in ('app','macos'):
        spec=importlib.util.spec_from_file_location(name+'_cc',str(ROOT/name/'cloudpc-connector.py'))
        m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        yield m


class SharedConnector(unittest.TestCase):
    def relay(self):
        spec=importlib.util.spec_from_file_location('cc_relay_model',str(ROOT/'app/cloudpc-relay.py'))
        m=importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules,{n:types.ModuleType(n) for n in ('fcntl','termios','tty')} if os.name=='nt' else {}):spec.loader.exec_module(m)
        return m

    def test_relay_echoes_only_the_matching_application_probe(self):
        m=self.relay();relay=m.Relay();replies=[];relay.emit=replies.append
        relay.packet({'t':'ping','nonce':'tested-nonce'})
        self.assertEqual(replies[0]['nonce'],'tested-nonce');self.assertEqual(replies[0]['t'],'pong')
        with self.assertRaises(ValueError):relay.packet({'t':'ping','nonce':'x'*65})

    def test_relay_reports_only_recent_clients_and_removes_silent_ones(self):
        import tempfile,time
        m=self.relay()
        with tempfile.TemporaryDirectory() as folder:
            relay=m.Relay(folder);clients=Path(folder)/'clients';self.assertEqual(relay.clients(),{'desktop':False,'cli':False})
            clients.mkdir()
            for name,age in (('desktop-new',0),('cli-old',60),('cli-gone',200),('other-new',0),('.mcp-tmp-x',0)):
                (clients/name).write_text('{}');then=time.time()-age;os.utime(clients/name,(then,then))
            self.assertEqual(relay.clients(),{'desktop':True,'cli':False})
            self.assertFalse((clients/'cli-gone').exists());self.assertTrue((clients/'cli-old').exists())
            os.utime(clients/'cli-old');self.assertEqual(relay.clients(),{'desktop':True,'cli':True})

    def test_client_kind_comes_from_the_mcp_client_name(self):
        for m in modules():
            for name,kind in (('claude-code','cli'),('Claude Code','cli'),('claude-ai','desktop'),('',  'desktop')):
                started=[]
                class Thread:
                    def __init__(self,target,daemon):started.append(daemon)
                    def start(self):pass
                written=[]
                with self.subTest(module=m.__name__,name=name),patch.object(m.threading,'Thread',Thread),patch.object(m.uuid,'uuid4',lambda:types.SimpleNamespace(hex='id')):
                    captured={}
                    original=m.threading.Thread
                    def spy(target,daemon):captured['beat']=target;return original(target=target,daemon=daemon)
                    with patch.object(m.threading,'Thread',spy):m.report_client(name)
                    class Stop(Exception):pass
                    def write(file,data,mode=0o600):written.append(file);raise Stop
                    with patch.object(m,'atomic_write',write),patch.object(m.time,'sleep',side_effect=Stop):
                        with self.assertRaises(Stop):captured['beat']()
                    self.assertEqual(written[0].name,kind+'-id');self.assertEqual(written[0].parent.name,'clients')

    def test_cc_install_accepts_desktop_with_or_without_cli_and_nothing_else(self):
        desktop,code=Path('/home/wdguest/.config/Claude/claude_desktop_config.json'),Path('/home/wdguest/.claude.json')
        for m in modules():
            for targets,okay in (([desktop],True),([desktop,code],True),([code],False),([desktop,Path('/home/wdguest/other.json')],False)):
                with self.subTest(module=m.__name__,targets=targets),patch.object(m,'CC_SHARED',True),patch.object(m,'read_json',return_value={}),patch.object(m,'shared_directory',side_effect=RuntimeError('reached')):
                    fake=lambda path:types.SimpleNamespace(is_symlink=lambda:False,exists=lambda:False)
                    with patch.object(m.Path,'is_symlink',return_value=False),patch.object(m.Path,'exists',return_value=False):
                        with self.assertRaises(RuntimeError if okay else ValueError):m.apply_install(Path('/home/wdguest/.local/share/cloudpc-link/x'),targets,{'tools':[]},'x')

    def test_shared_write_reaches_home_only_for_cli_config(self):
        for m in modules():
            for name,allowed in (('.claude.json',True),('.claude.json.mcp-backup-1',True),('.bashrc',False)):
                seen={}
                def directory(path,create=False,allow_home=False):seen['allow']=allow_home;raise RuntimeError('stop')
                with self.subTest(module=m.__name__,name=name),patch.dict(sys.modules,{'pwd':types.SimpleNamespace()}),patch.object(m,'shared_directory',directory),self.assertRaises(RuntimeError):m.shared_write(Path('/home/wdguest')/name,b'x')
                self.assertEqual(seen['allow'],allowed)

    def test_relay_requires_shared_directory_access_for_claude(self):
        m=self.relay();pwd=types.SimpleNamespace(getpwnam=lambda n:types.SimpleNamespace(pw_uid=2 if n=='wdterm' else 1,pw_gid=10))
        for mode in (0o2770,0o700,0o2777,0o4770):
            class ModelPath(PurePosixPath):
                def lstat(self):return types.SimpleNamespace(st_uid=1,st_gid=10,st_mode=stat.S_IFDIR|mode)
            with self.subTest(mode=mode),patch.object(m,'Path',ModelPath),patch.object(m,'CC_SHARED',True),patch.dict(sys.modules,{'pwd':pwd}),patch.object(m.os,'geteuid',create=True,return_value=2),patch.object(m.os,'getegid',create=True,return_value=10):
                if mode==0o2770:m.directory_mode('/home/wdguest/.local/share/cloudpc-link')
                else:
                    with self.assertRaises(RuntimeError):m.directory_mode('/home/wdguest/.local/share/cloudpc-link')

    def test_shared_directory_identity_path_and_mode(self):
        for m in modules():
            for case in ('valid','root','outside','foreign-owner','wrong-group','world-access','symlink','no-group-write'):
                calls=[];uid=0 if case=='root' else 2
                meta=types.SimpleNamespace(st_uid=99 if case=='foreign-owner' else 2,st_gid=99 if case=='wrong-group' else 10,
                    st_mode=stat.S_IFDIR|(0o2777 if case=='world-access' else 0o2700 if case=='no-group-write' else 0o2770))
                def open_dir(*args,**kwargs):
                    calls.append((args,kwargs))
                    if case=='symlink':raise OSError('modeled O_NOFOLLOW refusal')
                    return len(calls)+10
                fake=types.SimpleNamespace(O_RDONLY=0,O_DIRECTORY=1,O_NOFOLLOW=2,open=open_dir,close=lambda fd:None,
                    geteuid=lambda:uid,getegid=lambda:10,fstat=lambda fd:meta,fchmod=lambda *a:None,mkdir=lambda *a,**k:None)
                pwd=types.SimpleNamespace(getpwnam=lambda n:types.SimpleNamespace(pw_uid={'wdguest':1,'wdterm':2,'wdgui':3}[n],pw_gid=10))
                path=Path('/root') if case=='outside' else Path('/home/wdguest/.local/share/cloudpc-link/test')
                with self.subTest(module=m.__name__,case=case),patch.object(m,'os',fake),patch.dict(sys.modules,{'pwd':pwd}):
                    if case=='valid':
                        m.shared_directory(path,create=True)
                        self.assertTrue(all(args[1]&2 for args,_ in calls))
                    else:
                        with self.assertRaises((ValueError,OSError)):m.shared_directory(path,create=True)

    def test_shared_atomic_write_is_scoped_group_writable_and_preserves_bytes(self):
        for m in modules():
            events=[];data=b'{"existingSetting":"preserved","mcpServers":{}}\n'
            class Stream(io.BytesIO):
                def fileno(self):return 11
                def close(self):events.append(('bytes',self.getvalue()));super().close()
            fake=types.SimpleNamespace(O_WRONLY=1,O_CREAT=2,O_EXCL=4,O_NOFOLLOW=8,getegid=lambda:10,
                stat=lambda *a,**k:types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=3,st_gid=10,st_nlink=1),
                open=lambda *a,**k:11,fdopen=lambda *a:Stream(),fchmod=lambda fd,mode:events.append(('chmod',mode)),
                fsync=lambda fd:None,replace=lambda *a,**k:events.append(('replace',a,k)),unlink=lambda *a,**k:None,close=lambda fd:None)
            pwd=types.SimpleNamespace(getpwnam=lambda n:types.SimpleNamespace(pw_uid={'wdguest':1,'wdterm':2,'wdgui':3}[n]))
            with self.subTest(module=m.__name__),patch.object(m,'CC_SHARED',True),patch.object(m,'os',fake),patch.object(m,'shared_directory',return_value=5) as directory,patch.dict(sys.modules,{'pwd':pwd}):
                target=Path('/home/wdguest/.config/Claude/claude_desktop_config.json')
                m.atomic_write(target,data)
                directory.assert_called_once_with(target.parent,create=True,allow_home=False)
                self.assertIn(('chmod',0o660),events);self.assertIn(('bytes',data),events)
                renamed=next(e for e in events if e[0]=='replace')
                self.assertEqual(renamed[2],{'src_dir_fd':5,'dst_dir_fd':5})
                self.assertEqual(renamed[1][1],target.name)

    def test_shared_write_refuses_foreign_links_and_special_files(self):
        for m in modules():
            for attrs in ({'st_uid':99},{'st_gid':99},{'st_nlink':2},{'st_mode':stat.S_IFLNK|0o777},{'st_mode':stat.S_IFIFO|0o660}):
                meta=dict(st_uid=3,st_gid=10,st_nlink=1,st_mode=stat.S_IFREG|0o660);meta.update(attrs)
                with self.subTest(module=m.__name__,attrs=attrs),patch.object(m,'CC_SHARED',True),patch.object(m,'shared_directory',return_value=5),patch.object(m.os,'close'),patch.object(m.os,'unlink'),patch.object(m.os,'getegid',create=True,return_value=10),patch.object(m.os,'stat',return_value=types.SimpleNamespace(**meta)),patch.dict(sys.modules,{'pwd':types.SimpleNamespace(getpwnam=lambda n:types.SimpleNamespace(pw_uid=3))}):
                    with self.assertRaises(ValueError):m.shared_write(Path('/home/wdguest/.config/Claude/x'),b'data')

    def test_installed_config_preserves_existing_settings_and_mcp_servers(self):
        import tempfile
        import json
        for m in modules():
            with tempfile.TemporaryDirectory() as d:
                private=Path(d)/'.local/share/cloudpc-link/test';target=Path(d)/'.config/Claude/config.json'
                target.parent.mkdir(parents=True);original={'theme':'dark','mcpServers':{'existing':{'command':'keep'}}};target.write_text(json.dumps(original))
                changed,_=m.apply_install(private,[target],{'tools':[]},'test')
                updated=json.loads(target.read_text());self.assertEqual(changed,1);self.assertEqual(updated['theme'],'dark');self.assertEqual(updated['mcpServers']['existing'],original['mcpServers']['existing'])
                self.assertIn('--home',updated['mcpServers']['test']['args'])
                self.assertEqual(m.apply_install(private,[target],{'tools':[]},'test')[0],0)

    @unittest.skipUnless(os.name=='posix','NOT RUN: Linux cross-UID/socket permissions')
    def test_linux_cross_uid_socket(self):
        self.skipTest('NOT RUN: requires disposable Debian accounts and systemd')


if __name__=='__main__':unittest.main()
