#include "G2SimPlayerController.h"

#include "Camera/CameraComponent.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "HeadMountedDisplayFunctionLibrary.h"
#include "Engine/World.h"
#include "GameFramework/GameModeBase.h"
#include "G2SimCharacter.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "InputCoreTypes.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "UnrealEngine.h"

namespace
{
	constexpr float MouseSensitivity = 0.12f; // degrees per mouse count
	constexpr float MaxRoll = 25.f;
	constexpr float RollSpeed = 90.f; // degrees per second
	constexpr double ImuPeriod = 0.05; // 20 Hz to the hub; the app picks its own report pace
	constexpr double LocPeriod = 1.0;
	constexpr double MetersPerDegLat = 111320.0;
	constexpr float SnapTurnDeg = 30.f;
	constexpr float StickPress = 0.7f;   // a stick flick counts past this...
	constexpr float StickRelease = 0.3f; // ...and re-arms below this
}

AG2SimPlayerController::AG2SimPlayerController()
{
	PrimaryActorTick.bCanEverTick = true;
}

UG2HubSubsystem* AG2SimPlayerController::GetHub() const
{
	const UGameInstance* GI = GetGameInstance();
	return GI ? GI->GetSubsystem<UG2HubSubsystem>() : nullptr;
}

void AG2SimPlayerController::BeginPlay()
{
	Super::BeginPlay();
	if (!IsLocalController())
	{
		return;
	}
	bVR = UHeadMountedDisplayFunctionLibrary::IsHeadMountedDisplayEnabled();
	if (bVR)
	{
		if (AG2SimCharacter* C = Cast<AG2SimCharacter>(GetPawn()))
		{
			C->SetupVR();
		}
		SetControlRotation(FRotator(0, GetControlRotation().Yaw, 0));
		bHelp = false;
	}
	else
	{
		// Desktop glasses display placement, e.g. to leave room for overlays in a recording.
		float HudScale = 1.f;
		if (FParse::Value(FCommandLine::Get(), TEXT("hudscale="), HudScale))
		{
			DisplayWidth = FMath::Clamp(DisplayWidth * HudScale, 0.15f, 0.95f);
		}
		FParse::Value(FCommandLine::Get(), TEXT("hudx="), DisplayOffsetX);
	}
	if (!bVR && FParse::Param(FCommandLine::Get(), TEXT("cinematic")))
	{
		bCinematic = true;
		bHelp = false;
		FParse::Value(FCommandLine::Get(), TEXT("cineamount="), CineAmount);
		FSystemResolution::RequestResolutionChange(1920, 1080, EWindowMode::Windowed);
		GEngine->bEnableOnScreenDebugMessages = false; // no "Preparing textures" etc. on the recording
	}
	SetMouseFree(false);
}

void AG2SimPlayerController::OnPossess(APawn* InPawn)
{
	Super::OnPossess(InPawn);
	if (bVR)
	{
		if (AG2SimCharacter* C = Cast<AG2SimCharacter>(InPawn))
		{
			C->SetupVR();
		}
	}
}

void AG2SimPlayerController::EndPlay(const EEndPlayReason::Type Reason)
{
	EndLongPress();
	Super::EndPlay(Reason);
}

void AG2SimPlayerController::EndLongPress()
{
	if (!bLongPressing)
	{
		return;
	}
	bLongPressing = false;
	if (UG2HubSubsystem* Hub = GetHub())
	{
		Hub->SendGesture(LongPressSource, EG2Gesture::LongEnd);
	}
	Note(FString::Printf(TEXT("%s: longEnd"), UG2HubSubsystem::SourceName(LongPressSource)));
}

void AG2SimPlayerController::SetMouseFree(bool bFree)
{
	if (bFree)
	{
		EndLongPress();
	}
	bMouseFree = bFree;
	SetShowMouseCursor(bFree);
	if (bFree)
	{
		FInputModeGameAndUI Mode;
		Mode.SetHideCursorDuringCapture(false);
		SetInputMode(Mode);
	}
	else
	{
		SetInputMode(FInputModeGameOnly());
	}
}

void AG2SimPlayerController::Note(const FString& Text)
{
	LastAction = Text;
	LastActionTime = GetWorld()->GetRealTimeSeconds();
}

void AG2SimPlayerController::Gesture(EG2Gesture G)
{
	if (UG2HubSubsystem* Hub = GetHub())
	{
		Hub->SendGesture(Source, G);
	}
	Note(FString::Printf(TEXT("%s: %s"), UG2HubSubsystem::SourceName(Source), UG2HubSubsystem::GestureName(G)));
}

void AG2SimPlayerController::PlayerTick(float DeltaTime)
{
	Super::PlayerTick(DeltaTime);
	if (!IsLocalController())
	{
		return;
	}

	// Close a held long press whatever mode we are in (menu, free mouse),
	// including a release missed while the window had no focus.
	if (bLongPressing && !IsInputKeyDown(LongPressKey))
	{
		EndLongPress();
	}

	// Fell off the world somehow: back to the start.
	if (APawn* P = GetPawn(); P && P->GetActorLocation().Z < -2000.f)
	{
		if (AActor* Spawn = GetWorld()->GetAuthGameMode() ? GetWorld()->GetAuthGameMode()->FindPlayerStart(this) : nullptr)
		{
			P->TeleportTo(Spawn->GetActorLocation(), Spawn->GetActorRotation());
		}
	}

	if (bCinematic)
	{
		// Recording: no local gestures, the view moves by itself. Esc still
		// releases the mouse (a click takes it back, without a tap).
		if (WasInputKeyJustPressed(EKeys::Escape) || (bMouseFree && WasInputKeyJustPressed(EKeys::LeftMouseButton)))
		{
			SetMouseFree(!bMouseFree);
		}
		if (WasInputKeyJustPressed(EKeys::P)) bCinePaused = !bCinePaused;
		UpdateCinematicLook(DeltaTime);
		UpdateDisplayKeys(DeltaTime);
		UpdateSensors(DeltaTime);
		return;
	}

	if (WasInputKeyJustPressed(EKeys::Escape))
	{
		if (bMenuOpen)
		{
			bMenuOpen = false;
		}
		else
		{
			SetMouseFree(!bMouseFree);
		}
	}
	if (bVR)
	{
		UpdateVrInput(DeltaTime);
	}
	if (bMouseFree && !bVR)
	{
		// Click back into the window to resume; that click is not a tap.
		if (WasInputKeyJustPressed(EKeys::LeftMouseButton))
		{
			SetMouseFree(false);
		}
		UpdateSensors(DeltaTime);
		return;
	}

	UpdateLook(DeltaTime);
	UpdateMove();
	if (bMenuOpen)
	{
		UpdateMenuInput();
	}
	else
	{
		UpdateGlassesInput();
	}

	if (WasInputKeyJustPressed(EKeys::H)) bHelp = !bHelp;
	UpdateDisplayKeys(DeltaTime);
	UpdateSensors(DeltaTime);
}

void AG2SimPlayerController::UpdateDisplayKeys(float DeltaTime)
{
	if (WasInputKeyJustPressed(EKeys::G)) bShowGlasses = !bShowGlasses;
	if (IsInputKeyDown(EKeys::RightBracket)) DisplayWidth = FMath::Min(0.95f, DisplayWidth + DeltaTime * 0.3f);
	if (IsInputKeyDown(EKeys::LeftBracket)) DisplayWidth = FMath::Max(0.15f, DisplayWidth - DeltaTime * 0.3f);
	if (IsInputKeyDown(EKeys::PageUp)) DisplayCenterY = FMath::Max(0.1f, DisplayCenterY - DeltaTime * 0.3f);
	if (IsInputKeyDown(EKeys::PageDown)) DisplayCenterY = FMath::Min(0.9f, DisplayCenterY + DeltaTime * 0.3f);
}

void AG2SimPlayerController::UpdateCinematicLook(float DeltaTime)
{
	if (!GetPawn())
	{
		return;
	}
	if (!bCineBaseSet)
	{
		// The player start's view, captured once the pawn is in place.
		bCineBaseSet = true;
		// -cinepitch= / -cineyaw= (degrees) frame the shot relative to the start.
		float BasePitch = 0.f, BaseYaw = 0.f;
		FParse::Value(FCommandLine::Get(), TEXT("cinepitch="), BasePitch);
		FParse::Value(FCommandLine::Get(), TEXT("cineyaw="), BaseYaw);
		CineBase = FRotator(BasePitch, GetControlRotation().Yaw + BaseYaw, 0);
	}
	if (!bCinePaused)
	{
		CineTime += DeltaTime;
	}

	// A slow, aperiodic look-around: a few incommensurate sines per axis,
	// faded in over the first seconds so the view never jumps.
	const double T = CineTime;
	const double Wave = 2.0 * UE_DOUBLE_PI;
	const float Fade = FMath::SmoothStep(0.f, 6.f, float(T)) * CineAmount;
	const float Yaw = float(11.0 * FMath::Sin(Wave * T / 61.0) + 3.0 * FMath::Sin(Wave * T / 23.0 + 1.3));
	const float Pitch = float(1.8 * FMath::Sin(Wave * T / 31.0 + 0.7) + 0.5 * FMath::Sin(Wave * T / 13.0 + 2.0));
	const float Roll = float(0.9 * FMath::Sin(Wave * T / 37.0 + 2.1));
	SetControlRotation(FRotator(CineBase.Pitch + Pitch * Fade, CineBase.Yaw + Yaw * Fade, Roll * Fade));
}

void AG2SimPlayerController::UpdateLook(float DeltaTime)
{
	float Dx = 0.f, Dy = 0.f;
	GetInputMouseDelta(Dx, Dy);

	FRotator R = GetControlRotation();
	if (bVR)
	{
		// The headset owns pitch and roll; the mouse may still turn the body.
		R.Yaw = FRotator::NormalizeAxis(R.Yaw + Dx * MouseSensitivity);
		R.Pitch = 0.f;
		R.Roll = 0.f;
		SetControlRotation(R);
		return;
	}

	float Target = 0.f;
	if (IsInputKeyDown(EKeys::Q)) Target -= MaxRoll;
	if (IsInputKeyDown(EKeys::E)) Target += MaxRoll;
	HeadRoll = FMath::FInterpConstantTo(HeadRoll, Target, DeltaTime, RollSpeed);

	R.Yaw = FRotator::NormalizeAxis(R.Yaw + Dx * MouseSensitivity);
	R.Pitch = FMath::Clamp(FRotator::NormalizeAxis(R.Pitch) + Dy * MouseSensitivity, -85.f, 85.f);
	R.Roll = HeadRoll;
	SetControlRotation(R);
}

void AG2SimPlayerController::UpdateMove()
{
	APawn* P = GetPawn();
	if (!P)
	{
		return;
	}
	const FRotator YawOnly(0, GetControlRotation().Yaw, 0);
	const FVector Fwd = YawOnly.Vector();
	const FVector Right = FRotationMatrix(YawOnly).GetUnitAxis(EAxis::Y);
	float F = 0.f, S = 0.f;
	if (IsInputKeyDown(EKeys::W)) F += 1.f;
	if (IsInputKeyDown(EKeys::S)) F -= 1.f;
	if (IsInputKeyDown(EKeys::D)) S += 1.f;
	if (IsInputKeyDown(EKeys::A)) S -= 1.f;
	P->AddMovementInput(Fwd, F);
	P->AddMovementInput(Right, S);

	if (const ACharacter* C = Cast<ACharacter>(P))
	{
		const bool bRun = IsInputKeyDown(EKeys::LeftShift) || (bVR && IsInputKeyDown(EKeys::OculusTouch_Left_Thumbstick_Click));
		C->GetCharacterMovement()->MaxWalkSpeed = bRun ? AG2SimCharacter::RunSpeed : AG2SimCharacter::WalkSpeed;
	}
}

void AG2SimPlayerController::UpdateGlassesInput()
{
	if (bLongPressing && (WasInputKeyJustPressed(EKeys::One) || WasInputKeyJustPressed(EKeys::Two) || WasInputKeyJustPressed(EKeys::Three)))
	{
		EndLongPress();
	}
	if (WasInputKeyJustPressed(EKeys::One)) { Source = EG2Source::Right; Note(TEXT("source: right temple")); }
	if (WasInputKeyJustPressed(EKeys::Two)) { Source = EG2Source::Ring; Note(TEXT("source: ring")); }
	if (WasInputKeyJustPressed(EKeys::Three)) { Source = EG2Source::Left; Note(TEXT("source: left temple")); }
	if (WasInputKeyJustPressed(EKeys::Tab))
	{
		EndLongPress(); // a press never changes source midway
		Source = Source == EG2Source::Right ? EG2Source::Ring : Source == EG2Source::Ring ? EG2Source::Left : EG2Source::Right;
		Note(FString::Printf(TEXT("source: %s"), UG2HubSubsystem::SourceName(Source)));
	}

	if (WasInputKeyJustPressed(EKeys::LeftMouseButton)) Gesture(EG2Gesture::Tap);
	if (WasInputKeyJustPressed(EKeys::MouseScrollUp) || WasInputKeyJustPressed(EKeys::Up)) Gesture(EG2Gesture::Up);
	if (WasInputKeyJustPressed(EKeys::MouseScrollDown) || WasInputKeyJustPressed(EKeys::Down)) Gesture(EG2Gesture::Down);
	if (WasInputKeyJustPressed(EKeys::X)) Gesture(EG2Gesture::Double);
	if (WasInputKeyJustPressed(EKeys::F))
	{
		StartLongPress(EKeys::F);
	}
	if (WasInputKeyJustPressed(EKeys::RightMouseButton) || WasInputKeyJustPressed(EKeys::C))
	{
		OpenMenu();
	}
}

void AG2SimPlayerController::StartLongPress(const FKey& Key)
{
	if (bLongPressing)
	{
		return;
	}
	bLongPressing = true;
	LongPressSource = Source;
	LongPressKey = Key;
	Gesture(EG2Gesture::LongStart);
}

void AG2SimPlayerController::OpenMenu()
{
	const UG2HubSubsystem* Hub = GetHub();
	if (Hub && Hub->GetMenu().Num() > 0)
	{
		EndLongPress();
		bMenuOpen = true;
		MenuIndex = 0;
	}
	else
	{
		Note(TEXT("no context menu on this screen"));
	}
}

void AG2SimPlayerController::MoveMenu(int32 Delta)
{
	const UG2HubSubsystem* Hub = GetHub();
	const int32 N = Hub ? Hub->GetMenu().Num() : 0;
	if (N > 0)
	{
		MenuIndex = ((MenuIndex + Delta) % N + N) % N;
	}
}

void AG2SimPlayerController::SendMenuSelection()
{
	UG2HubSubsystem* Hub = GetHub();
	if (Hub && Hub->GetMenu().IsValidIndex(MenuIndex))
	{
		const FG2MenuItem& Item = Hub->GetMenu()[MenuIndex];
		Hub->SendMenu(Item.Id);
		Note(FString::Printf(TEXT("menu: %s"), *Item.Label));
	}
	bMenuOpen = false;
}

void AG2SimPlayerController::UpdateMenuInput()
{
	UG2HubSubsystem* Hub = GetHub();
	const int32 N = Hub ? Hub->GetMenu().Num() : 0;
	if (N == 0)
	{
		bMenuOpen = false;
		return;
	}
	MenuIndex = FMath::Clamp(MenuIndex, 0, N - 1);
	if (WasInputKeyJustPressed(EKeys::MouseScrollUp) || WasInputKeyJustPressed(EKeys::Up)) MoveMenu(-1);
	if (WasInputKeyJustPressed(EKeys::MouseScrollDown) || WasInputKeyJustPressed(EKeys::Down)) MoveMenu(1);
	if (WasInputKeyJustPressed(EKeys::LeftMouseButton) || WasInputKeyJustPressed(EKeys::Enter))
	{
		SendMenuSelection();
	}
	if (WasInputKeyJustPressed(EKeys::RightMouseButton) || WasInputKeyJustPressed(EKeys::C))
	{
		bMenuOpen = false;
	}
}

void AG2SimPlayerController::UpdateSensors(float DeltaTime)
{
	UG2HubSubsystem* Hub = GetHub();
	const APawn* P = GetPawn();
	if (!Hub || !P)
	{
		return;
	}

	// Head pose as IMU: x = pitch (nod), y = yaw (shake), z = roll (tilt), degrees.
	// The camera carries the real head pose in VR and the mouse look + Q/E roll on desktop.
	const AG2SimCharacter* C = Cast<AG2SimCharacter>(P);
	const FRotator R = C && C->GetCamera() ? C->GetCamera()->GetComponentRotation() : GetControlRotation();
	LastImu = FVector(FRotator::NormalizeAxis(R.Pitch), FRotator::NormalizeAxis(R.Yaw), FRotator::NormalizeAxis(R.Roll));
	ImuAccum += DeltaTime;
	if (ImuAccum >= ImuPeriod)
	{
		ImuAccum = 0.0;
		if (Hub->IsImuOn())
		{
			Hub->SendImu(LastImu);
		}
	}

	// Position as GPS: equirectangular around the origin (fine for a few km).
	const FVector L = P->GetActorLocation();
	Lat = OriginLat + (L.X / 100.0) / MetersPerDegLat;
	Lon = OriginLon + (L.Y / 100.0) / (MetersPerDegLat * FMath::Cos(FMath::DegreesToRadians(OriginLat)));
	LocAccum += DeltaTime;
	if (LocAccum >= LocPeriod)
	{
		LocAccum = 0.0;
		const double Heading = FMath::Fmod(R.Yaw + 360.0, 360.0); // UE yaw is clockwise from +X (north)
		Hub->SendLocation(Lat, Lon, Heading, P->GetVelocity().Size2D() / 100.0);
	}
}

void AG2SimPlayerController::UpdateVrInput(float DeltaTime)
{
	using K = EKeys;
	const AG2SimCharacter* C = Cast<AG2SimCharacter>(GetPawn());

	// Walk where the head looks (yaw only); left stick click to run.
	if (C)
	{
		const float Yaw = C->GetCamera()->GetComponentRotation().Yaw;
		const FRotator YawOnly(0, Yaw, 0);
		GetPawn()->AddMovementInput(YawOnly.Vector(), GetInputAnalogKeyState(K::OculusTouch_Left_Thumbstick_Y));
		GetPawn()->AddMovementInput(FRotationMatrix(YawOnly).GetUnitAxis(EAxis::Y), GetInputAnalogKeyState(K::OculusTouch_Left_Thumbstick_X));
	}

	const float RX = GetInputAnalogKeyState(K::OculusTouch_Right_Thumbstick_X);
	const float RY = GetInputAnalogKeyState(K::OculusTouch_Right_Thumbstick_Y);

	// Hold left grip: the right stick moves / resizes the glasses display.
	if (IsInputKeyDown(K::OculusTouch_Left_Grip_Click))
	{
		VrPitchDeg = FMath::Clamp(VrPitchDeg + RY * DeltaTime * 10.f, -25.f, 25.f);
		VrWidthDeg = FMath::Clamp(VrWidthDeg + RX * DeltaTime * 10.f, 10.f, 60.f);
		bStickLatched = true; // no flick when the grip is let go mid-push
		return;
	}

	// Right stick flicks: left / right snap turn, up / down swipe (or menu selection).
	if (bStickLatched)
	{
		if (FMath::Abs(RX) < StickRelease && FMath::Abs(RY) < StickRelease)
		{
			bStickLatched = false;
		}
	}
	else if (FMath::Max(FMath::Abs(RX), FMath::Abs(RY)) > StickPress)
	{
		bStickLatched = true;
		if (FMath::Abs(RX) > FMath::Abs(RY))
		{
			SnapTurn(FMath::Sign(RX) * SnapTurnDeg);
		}
		else if (bMenuOpen)
		{
			MoveMenu(RY > 0 ? -1 : 1);
		}
		else
		{
			Gesture(RY > 0 ? EG2Gesture::Up : EG2Gesture::Down);
		}
	}

	if (WasInputKeyJustPressed(K::OculusTouch_Left_Y_Click))
	{
		bHelp = !bHelp; // the info panel in VR
	}

	if (bMenuOpen)
	{
		if (WasInputKeyJustPressed(K::OculusTouch_Right_Trigger_Click)) SendMenuSelection();
		if (WasInputKeyJustPressed(K::OculusTouch_Right_Grip_Click)) bMenuOpen = false;
		return;
	}

	if (WasInputKeyJustPressed(K::OculusTouch_Left_X_Click))
	{
		EndLongPress();
		Source = Source == EG2Source::Right ? EG2Source::Ring : Source == EG2Source::Ring ? EG2Source::Left : EG2Source::Right;
		Note(FString::Printf(TEXT("source: %s"), UG2HubSubsystem::SourceName(Source)));
	}
	if (WasInputKeyJustPressed(K::OculusTouch_Right_Trigger_Click)) Gesture(EG2Gesture::Tap);
	if (WasInputKeyJustPressed(K::OculusTouch_Right_A_Click)) Gesture(EG2Gesture::Double);
	if (WasInputKeyJustPressed(K::OculusTouch_Right_B_Click)) StartLongPress(K::OculusTouch_Right_B_Click);
	if (WasInputKeyJustPressed(K::OculusTouch_Right_Grip_Click)) OpenMenu();
}

void AG2SimPlayerController::SnapTurn(float DeltaYaw)
{
	FRotator R = GetControlRotation();
	R.Yaw = FRotator::NormalizeAxis(R.Yaw + DeltaYaw);
	SetControlRotation(R);

	// Turn around the head, not the tracking origin: when the player stands
	// away from the origin, rotating the body alone would swing the view.
	APawn* P = GetPawn();
	const AG2SimCharacter* C = Cast<AG2SimCharacter>(P);
	if (!P || !C)
	{
		return;
	}
	const FVector Before = C->GetCamera()->GetComponentLocation();
	P->SetActorRotation(FRotator(0, R.Yaw, 0));
	FVector Shift = Before - C->GetCamera()->GetComponentLocation();
	Shift.Z = 0;
	P->AddActorWorldOffset(Shift, true);
}
