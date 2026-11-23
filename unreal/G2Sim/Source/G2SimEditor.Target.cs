using UnrealBuildTool;

public class G2SimEditorTarget : TargetRules
{
	public G2SimEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("G2Sim");
	}
}
