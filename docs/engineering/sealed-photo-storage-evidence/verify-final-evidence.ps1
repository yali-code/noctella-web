$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dest=Join-Path (Get-Location) 'docs/engineering/sealed-photo-storage-evidence'
$z=[System.IO.Compression.ZipFile]::OpenRead((Join-Path $dest 'photo-storage-capability-38579084392.zip'))
$rows=@();$readable=@();$output=''
try{foreach($e in $z.Entries){if($e.FullName -match 'evidence.json$|^test-output.txt$'){$reader=[System.IO.StreamReader]::new($e.Open());try{$text=$reader.ReadToEnd()}finally{$reader.Dispose()};if($e.FullName -eq 'test-output.txt'){$output=$text;continue};$o=$text | ConvertFrom-Json;if($o.sourceSha -ne '0c18d9813299fbc56838fdc40764a538fac9a8c8'){throw 'Source mismatch'};if($o.name -eq 'final-state'){continue};$photo=@($o.files | Where-Object {$_.key -match '\.webp$' -and $_.kind -eq 'file'});$unique=@($photo | Group-Object {$_.dev.ToString()+':'+$_.ino.ToString()} | ForEach-Object {$_.Group[0]});$size=($unique | Measure-Object -Property bytes -Sum).Sum;$allocated=($unique | Measure-Object -Property blocks -Sum).Sum*512;$rows+=@{driver=$o.driver;name=$o.name;sourceSha=$o.sourceSha;canonicalFiles=@($o.files | Where-Object {$_.key -match '^canonical/'}).Count;uniqueWebpInodes=$unique.Count;photoPayloadBytes=$size;photoAllocatedBytes=$allocated;death=$o.death;locked=$o.locked;databaseOperationCount=@($o.database.operations).Count;outboxCount=@($o.database.outbox).Count};$readable+=@{entry=$e.FullName;evidence=$o}}}}finally{$z.Dispose()}
$kills=@($rows | Where-Object {$_.name -match '^kill-'});if($kills.Count -ne 12 -or @($kills | Where-Object {$_.death.signal -ne 'SIGKILL'}).Count -ne 0){throw 'SIGKILL evidence incomplete'}
if($output -notmatch '# pass 48' -or $output -notmatch '# fail 0' -or $output -notmatch '# skipped 0'){throw 'Final suite incomplete'}
$rows | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $dest 'final-results.json') -Encoding UTF8
$readable | ConvertTo-Json -Depth 70 | Set-Content -LiteralPath (Join-Path $dest 'final-preservation-evidence.json') -Encoding UTF8
[System.IO.File]::WriteAllText((Join-Path $dest 'linux-final-test-output.txt'),$output)
$rows | Where-Object {$_.name -eq 'inode-isolation'} | ConvertTo-Json
Write-Output ('Final named checkpoints: '+$rows.Count+'; Linux SIGKILL cases: '+$kills.Count)
