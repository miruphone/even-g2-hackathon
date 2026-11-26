<#
  Package G2Sim.exe (Win64 Shipping) and zip it for a GitHub release.

    powershell -ExecutionPolicy Bypass -File unreal/G2Sim/package.ps1 [-Engine C:\Epic\UE_5.8]

  Output: unreal/G2Sim/Packaged/Windows (the build) and
          unreal/G2Sim/Packaged/G2Sim-Win64.zip (without .pdb debug files).
#>
param(
  [string]$Engine = 'C:\Epic\UE_5.8'
)
$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'G2Sim.uproject'
$out = Join-Path $PSScriptRoot 'Packaged'

# The cooker loads the OpenXR plugin, which connects to the PC's active
# OpenXR runtime. Some runtimes (seen with Varjo) keep the cooker from ever
# exiting. Point the loader at no runtime for the build only.
# Restored afterwards, so a later `G2Sim.exe -vr` from the same shell still finds the runtime.
$previousRuntime = $env:XR_RUNTIME_JSON
$env:XR_RUNTIME_JSON = Join-Path $env:TEMP 'g2sim-no-openxr-runtime.json'
try {
  # -noxgeshadercompile: with IncrediBuild installed, the cooker handed new
  # shaders to XGE and waited on them forever. Compile them locally.
  & (Join-Path $Engine 'Engine\Build\BatchFiles\RunUAT.bat') BuildCookRun `
    "-project=$project" -platform=Win64 -clientconfig=Shipping `
    -build -cook -stage -pak -iostore -archive "-archivedirectory=$out" `
    -nop4 -utf8output -unattended `
    -AdditionalCookerOptions=-noxgeshadercompile
  if ($LASTEXITCODE -ne 0) { throw "BuildCookRun failed ($LASTEXITCODE)" }
}
finally {
  if ($null -eq $previousRuntime) { Remove-Item Env:XR_RUNTIME_JSON -ErrorAction SilentlyContinue }
  else { $env:XR_RUNTIME_JSON = $previousRuntime }
}

$stageRoot = Join-Path $out 'zipstage'
$stage = Join-Path $stageRoot 'G2Sim'
if (Test-Path $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item -Path (Join-Path $out 'Windows\*') -Destination $stage -Recurse -Force -Exclude '*.pdb', 'Manifest_*.txt'

$zip = Join-Path $out 'G2Sim-Win64.zip'
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal -Force
Remove-Item -LiteralPath $stageRoot -Recurse -Force
'{0} ({1:N0} MB)' -f $zip, ((Get-Item $zip).Length / 1MB)
