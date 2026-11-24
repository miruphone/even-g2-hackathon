#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "G2SimHUD.generated.h"

class UG2FaceLayer;
class UCanvasRenderTarget2D;

/**
 * Desktop: draws the glasses display head-locked over the view (the frame's alpha is
 * the pixel brightness, so the background stays see-through like the real
 * waveguide), plus the simulator's own overlays: status, help, context menu.
 *
 * VR: a flat HUD does not reach the headset, so the glasses display becomes a
 * face-locked compositor layer, and status / context menu are drawn into a
 * render target shown as a second, smaller layer below the line of sight.
 */
UCLASS()
class G2SIM_API AG2SimHUD : public AHUD
{
	GENERATED_BODY()

public:
	AG2SimHUD();
	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;
	virtual void DrawHUD() override;

private:
	void SetupVR();
	UFUNCTION()
	void DrawPanel(UCanvas* InCanvas, int32 Width, int32 Height);

	void DrawGlasses(class AG2SimPlayerController* PC, class UG2HubSubsystem* Hub);
	void DrawStatus(class AG2SimPlayerController* PC, class UG2HubSubsystem* Hub);
	void DrawHelp();
	void DrawMenu(class AG2SimPlayerController* PC, class UG2HubSubsystem* Hub);
	void Panel(float X, float Y, float W, float H);

	UPROPERTY(Transient)
	TObjectPtr<UG2FaceLayer> GlassesLayer;
	UPROPERTY(Transient)
	TObjectPtr<UG2FaceLayer> PanelLayer;
	UPROPERTY(Transient)
	TObjectPtr<UCanvasRenderTarget2D> PanelTarget;
	double NextPanelUpdate = 0.0;
	bool bVR = false;
};
