$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$key = $rsa.ExportPkcs8PrivateKey()
$b64 = [Convert]::ToBase64String($key, [Base64FormattingOptions]::InsertLineBreaks)
Write-Output $b64
