import pathlib,json,subprocess,os,shutil
R=pathlib.Path('/vol1/1000/docker/trilium/migrations/20261023-oknote');assert json.loads((R/'retirement.json').read_text())['uninstalled'];assert (R/'oknote-native-extra.tar.gz').is_file()
cs=json.loads(subprocess.check_output(['docker','inspect']+subprocess.check_output(['docker','ps','-aq'],text=True).split()));removed=[]
for kind in ['@appmeta','@apphome','@apptemp','@appconf']:
 p=pathlib.Path('/vol1')/kind/'oknote'
 if p.exists():
  assert not p.is_symlink() and not os.path.ismount(p)
  assert not any(m['Source']==str(p) or m['Source'].startswith(str(p)+'/') for c in cs for m in c['Mounts'])
  assert not any(x.is_symlink() or (x.is_dir() and os.path.ismount(x)) for x in p.rglob('*'))
  shutil.rmtree(p);removed.append(kind)
report={'remaining_native_directories_removed':removed,'all_native_directories_absent':True};(R/'residue-check.json').write_text(json.dumps(report));print(json.dumps(report))
