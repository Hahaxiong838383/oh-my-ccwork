import pathlib,json,tarfile,hashlib
R=pathlib.Path('/vol1/1000/docker/trilium/migrations/20261023-oknote');roots=[pathlib.Path('/vol1')/n/'oknote' for n in ['@appmeta','@apphome','@apptemp','@appconf']];r={}
with tarfile.open(R/'oknote-native-extra.tar.gz','w:gz',dereference=False) as t:
 for p in roots:
  if p.exists():t.add(p,arcname=p.parent.name+'/oknote');r[p.parent.name]={'files':sum(x.is_file() for x in p.rglob('*'))}
scripts={str(p.relative_to('/var/apps/oknote')):p.read_text() for p in pathlib.Path('/var/apps/oknote/cmd').rglob('*') if p.is_file() and not p.name.startswith('.') and 'uninstall' in p.name and p.stat().st_size<20000}
print(json.dumps({'extra_archives':r,'uninstall_scripts':scripts,'wizard_uninstall_exists':pathlib.Path('/var/apps/oknote/wizard/uninstall').exists()}))
