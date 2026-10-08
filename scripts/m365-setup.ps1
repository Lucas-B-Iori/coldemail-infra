param(
  [string] $AppId = "defa3e27-6317-4576-9e12-39776c2c0f09",
  [string] $TargetObjectId = "e054e310-d56b-4755-8665-eb8c119a4274"
)

$mailboxes = @(
  'lucas@synapzeai.net',
  'miguel@synapzeai.net',
  'felipe@synapzeai.net',
  'pedro@synapzeai.net',
  'gabriel@synapzeai.net',
  'camila@synapzeai.net',
  'mariana@synapzeai.net',
  'isabela@synapzeai.net',
  'lionel@synapzeai.net'
)

$logFile = "data\setup-log.txt"
function Log-Msg($msg) {
  Write-Host $msg
  Add-Content -Path $logFile -Value $msg
}

Set-Content -Path $logFile -Value "--- Setup M365 Log $(Get-Date) ---"

Log-Msg "Conectando ao Exchange Online como lucas@synapzeai.net..."
Connect-ExchangeOnline -UserPrincipalName 'lucas@synapzeai.net' -ShowBanner:$false

# 1) Inspeciona Service Principal atual
$sp = Get-ServicePrincipal -Identity $AppId -ErrorAction SilentlyContinue

if ($sp) {
  Log-Msg "Service Principal existente: DisplayName=$($sp.DisplayName), Identity=$($sp.Identity), ObjectId=$($sp.ObjectId), ServiceId=$($sp.ServiceId)"
  if ($sp.ObjectId -ne $TargetObjectId -and $sp.ServiceId -ne $TargetObjectId) {
    Log-Msg "ObjectId incorreto detectado ($($sp.ObjectId)). Recriando com o Enterprise App ObjectId correto ($TargetObjectId)..."
    try {
      Remove-ServicePrincipal -Identity $sp.Identity -Confirm:$false -ErrorAction Stop
      Log-Msg "Service Principal antigo removido."
    } catch {
      Log-Msg "Aviso ao remover Service Principal antigo: $($_.Exception.Message)"
    }
    $sp = $null
  }
}

if (-not $sp) {
  Log-Msg "Registrando Service Principal com AppId=$AppId e ObjectId=$TargetObjectId ..."
  try {
    $sp = New-ServicePrincipal -AppId $AppId -ObjectId $TargetObjectId -DisplayName "ColdMail Engine" -ErrorAction Stop
    Log-Msg "Service Principal criado com sucesso!"
  } catch {
    Log-Msg "Erro ao criar Service Principal: $($_.Exception.Message)"
  }
}

$principalIdentity = if ($sp) { $sp.Identity } else { $TargetObjectId }
Log-Msg "Usando ServicePrincipal Identity: $principalIdentity para permissoes..."

foreach ($m in $mailboxes) {
  # FullAccess (necessario para IMAP XOAUTH2)
  try {
    Add-MailboxPermission -Identity $m -User $principalIdentity -AccessRights FullAccess -AutoMapping:$false -Confirm:$false -ErrorAction Stop | Out-Null
    Log-Msg "  [OK] FullAccess vinculado: $m"
  } catch {
    Log-Msg "  [ERRO] FullAccess em $m : $($_.Exception.Message)"
  }

  # SendAs (necessario para SMTP SendAsApp)
  try {
    Add-RecipientPermission -Identity $m -Trustee $principalIdentity -AccessRights SendAs -Confirm:$false -ErrorAction Stop | Out-Null
    Log-Msg "  [OK] SendAs vinculado: $m"
  } catch {
    Log-Msg "  [ERRO] SendAs em $m : $($_.Exception.Message)"
  }

  # CASMailbox (habilita IMAP e libera SMTP AUTH)
  try {
    Set-CASMailbox -Identity $m -ImapEnabled $true -SmtpClientAuthenticationDisabled $false -ErrorAction Stop
    Log-Msg "  [OK] IMAP habilitado e SMTP AUTH liberado: $m"
  } catch {
    Log-Msg "  [ERRO] Set-CASMailbox em $m : $($_.Exception.Message)"
  }
}

Log-Msg ""
Log-Msg "Validando autorizacao do Service Principal..."
try {
  $test = Test-ServicePrincipalAuthorization -Identity $AppId -Resource "lucas@synapzeai.net" -ErrorAction Stop
  Log-Msg "Test-ServicePrincipalAuthorization: InScope = $($test.InScope)"
} catch {
  Log-Msg "Test-ServicePrincipalAuthorization: $($_.Exception.Message)"
}

Log-Msg ""
Log-Msg "Configuracao do Exchange concluida!"
Set-Content -Path "data\setup-complete.flag" -Value (Get-Date).ToString("s")
Disconnect-ExchangeOnline -Confirm:$false
