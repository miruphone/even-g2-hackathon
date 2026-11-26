#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "G2HubSubsystem.h"
#include "G2SimPlayerController.generated.h"

/**
 * Desktop controls for the G2 simulator. Keys are polled each tick, so the
 * project needs no input assets.
 *
 *   Mouse look, WASD walk, Shift run, Q / E tilt head
 *   Left click tap, wheel or Up / Down swipe, X double tap, hold F long press
 *   1 / 2 / 3 or Tab: input source (right temple / ring / left temple)
 *   Right click or C: context menu (wheel to choose, click to send)
 *   G show / hide glasses, [ ] size, PgUp / PgDn height, H help, Esc free mouse
 *
 * VR (run with -vr, Quest via Link / Air Link as the OpenXR runtime):
 *   Left stick walk (click: run), right stick left / right snap turn
 *   Right trigger tap, right stick up / down swipe, A double tap, hold B long press
 *   Right grip context menu (stick to choose, trigger to send), X input source,
 *   Y info panel, hold left grip + right stick: display height / size
 *
 * The head pose is streamed as IMU while the app has IMU on, and the
 * position is sent as GPS (+X north, +Y east from Tokyo Station).
 *
 * -cinematic (desktop, for recording): 1920x1080 window, no cursor, help or
 * status bar, and a slow automatic look-around. Mouse and gesture keys are
 * ignored, so gestures come only from outside through the hub.
 * P pauses / resumes the motion; G, [ ], PgUp / PgDn still adjust the display.
 */
UCLASS()
class G2SIM_API AG2SimPlayerController : public APlayerController
{
	GENERATED_BODY()

public:
	AG2SimPlayerController();

	virtual void BeginPlay() override;
	virtual void PlayerTick(float DeltaTime) override;
	virtual void EndPlay(const EEndPlayReason::Type Reason) override;
	virtual void OnPossess(APawn* InPawn) override;

	// UI state read by AG2SimHUD.
	bool bVR = false;
	bool bCinematic = false;
	float VrWidthDeg = 24.f; // apparent width of the glasses display
	float VrPitchDeg = 2.f;  // its height above the view centre
	EG2Source Source = EG2Source::Right;
	bool bMenuOpen = false;
	int32 MenuIndex = 0;
	bool bHelp = true;
	bool bShowGlasses = true;
	bool bLongPressing = false;
	bool bMouseFree = false;
	float DisplayWidth = 0.42f;   // fraction of the screen width
	float DisplayCenterY = 0.40f; // fraction of the screen height
	float DisplayOffsetX = 0.f;   // -hudx=: horizontal shift in 1920-wide pixels (+ = right)
	FString LastAction;
	double LastActionTime = -100.0;
	FVector LastImu = FVector::ZeroVector;
	double Lat = 0.0;
	double Lon = 0.0;

	UG2HubSubsystem* GetHub() const;

	static constexpr double OriginLat = 35.681236; // Tokyo Station
	static constexpr double OriginLon = 139.767125;

private:
	void Gesture(EG2Gesture G);
	/** Sends longEnd from the source that started the press, if one is held. */
	void EndLongPress();
	void Note(const FString& Text);
	void SetMouseFree(bool bFree);
	void UpdateLook(float DeltaTime);
	void UpdateCinematicLook(float DeltaTime);
	void UpdateDisplayKeys(float DeltaTime);
	void UpdateMove();
	void UpdateGlassesInput();
	void UpdateMenuInput();
	void UpdateSensors(float DeltaTime);
	void UpdateVrInput(float DeltaTime);
	void OpenMenu();
	void MoveMenu(int32 Delta);
	void SendMenuSelection();
	void StartLongPress(const FKey& Key);
	void SnapTurn(float DeltaYaw);

	float HeadRoll = 0.f;
	// Cinematic look-around: offsets from CineBase over CineTime (paused with P).
	bool bCineBaseSet = false;
	bool bCinePaused = false;
	FRotator CineBase = FRotator::ZeroRotator;
	double CineTime = 0.0;
	float CineAmount = 1.f; // -cineamount= scales the motion (0 = still)
	EG2Source LongPressSource = EG2Source::Right;
	FKey LongPressKey;
	bool bStickLatched = false;
	double ImuAccum = 0.0;
	double LocAccum = 0.0;
};
