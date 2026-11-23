#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "G2SimHUD.generated.h"

/**
 * Draws the glasses display head-locked over the view (the frame's alpha is
 * the pixel brightness, so the background stays see-through like the real
 * waveguide), plus the simulator's own overlays: status, help, context menu.
 */
UCLASS()
class G2SIM_API AG2SimHUD : public AHUD
{
	GENERATED_BODY()

public:
	virtual void DrawHUD() override;

private:
	void DrawGlasses(class AG2SimPlayerController* PC, class UG2HubSubsystem* Hub);
	void DrawStatus(class AG2SimPlayerController* PC, class UG2HubSubsystem* Hub);
	void DrawHelp();
	void DrawMenu(class AG2SimPlayerController* PC, class UG2HubSubsystem* Hub);
	void Panel(float X, float Y, float W, float H);
};
