using UnrealBuildTool;

public class G2Sim : ModuleRules
{
	public G2Sim(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "InputCore" });
		PrivateDependencyModuleNames.AddRange(new[] { "WebSockets", "Json", "ImageWrapper", "RenderCore", "RHI" });
	}
}
