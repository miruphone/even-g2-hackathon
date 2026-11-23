using UnrealBuildTool;

public class G2SimTarget : TargetRules
{
	public G2SimTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("G2Sim");
	}
}
