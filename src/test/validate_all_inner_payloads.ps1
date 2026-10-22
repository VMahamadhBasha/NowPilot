param(
    [string]$FilePath = "update_sets\now_pilot_scoped.xml"
)

Write-Host "Extracting and parsing inner XML payloads for: $FilePath"

[xml]$doc = Get-Content -Raw -Path $FilePath
$updateNodes = $doc.SelectNodes("//sys_update_xml")

Write-Host "Found $($updateNodes.Count) sys_update_xml records."

$failedCount = 0
$recordIndex = 0

foreach ($node in $updateNodes) {
    $recordIndex++
    $targetName = $node.target_name
    $type = $node.type
    $name = $node.name
    $payload = $node.payload

    if ([string]::IsNullOrWhiteSpace($payload)) {
        Write-Host "[$recordIndex] [FAIL] Empty payload for $type - $targetName" -ForegroundColor Red
        $failedCount++
        continue
    }

    try {
        [xml]$innerDoc = $payload
    } catch {
        Write-Host "[$recordIndex] [FAIL] Inner XML parse error in $type - $targetName ($name): $_" -ForegroundColor Red
        $failedCount++
    }
}

if ($failedCount -eq 0) {
    Write-Host "[SUCCESS] All $($updateNodes.Count) inner payloads parsed as 100% valid XML!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "[FAILURE] $failedCount inner payloads failed XML parsing!" -ForegroundColor Red
    exit 1
}
