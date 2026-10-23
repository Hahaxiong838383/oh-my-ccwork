import pathlib,tarfile,json,os
R=pathlib.Path('/vol1/1000/docker/trilium/migrations/20261023-oknote');S=pathlib.Path('/var/apps/oknote');os.umask(0o077)
# App Center stores lifecycle scripts separately from the Docker payload.
found=[]
for p in S.iterdir():found.append({'name':p.name,'symlink':p.is_symlink(),'target':os.readlink(p) if p.is_symlink() else None})
with tarfile.open(R/'oknote-native-entry.tar.gz','w:gz',dereference=False) as t:t.add(S,arcname='oknote')
print(json.dumps({'native_entry_exists':S.exists(),'entries':found,'archive_bytes':(R/'oknote-native-entry.tar.gz').stat().st_size}))
