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
 * The head pose is streamed as IMU while the app has IMU on, and the
 * position is sent as GPS (+X north, +Y east from Tokyo Station).
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

	// UI state read by AG2SimHUD.
	EG2Source Source = EG2Source::Right;
	bool bMenuOpen = false;
	int32 MenuIndex = 0;
	bool bHelp = true;
	bool bShowGlasses = true;
	bool bLongPressing = false;
	bool bMouseFree = false;
	float DisplayWidth = 0.42f;   // fraction of the screen width
	float DisplayCenterY = 0.40f; // fraction of the screen height
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
	void UpdateMove();
	void UpdateGlassesInput();
	void UpdateMenuInput();
	void UpdateSensors(float DeltaTime);

	float HeadRoll = 0.f;
	EG2Source LongPressSource = EG2Source::Right;
	double ImuAccum = 0.0;
	double LocAccum = 0.0;
};
