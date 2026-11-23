#include "G2SimPlayerController.h"

#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "GameFramework/GameModeBase.h"
#include "G2SimCharacter.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "InputCoreTypes.h"

namespace
{
	constexpr float MouseSensitivity = 0.12f; // degrees per mouse count
	constexpr float MaxRoll = 25.f;
	constexpr float RollSpeed = 90.f; // degrees per second
	constexpr double ImuPeriod = 0.05; // 20 Hz to the hub; the app picks its own report pace
	constexpr double LocPeriod = 1.0;
	constexpr double MetersPerDegLat = 111320.0;
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
	if (IsLocalController())
	{
		SetMouseFree(false);
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
	if (bLongPressing && !IsInputKeyDown(EKeys::F))
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
	if (bMouseFree)
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

	// View toggles.
	if (WasInputKeyJustPressed(EKeys::H)) bHelp = !bHelp;
	if (WasInputKeyJustPressed(EKeys::G)) bShowGlasses = !bShowGlasses;
	if (IsInputKeyDown(EKeys::RightBracket)) DisplayWidth = FMath::Min(0.95f, DisplayWidth + DeltaTime * 0.3f);
	if (IsInputKeyDown(EKeys::LeftBracket)) DisplayWidth = FMath::Max(0.15f, DisplayWidth - DeltaTime * 0.3f);
	if (IsInputKeyDown(EKeys::PageUp)) DisplayCenterY = FMath::Max(0.1f, DisplayCenterY - DeltaTime * 0.3f);
	if (IsInputKeyDown(EKeys::PageDown)) DisplayCenterY = FMath::Min(0.9f, DisplayCenterY + DeltaTime * 0.3f);

	UpdateSensors(DeltaTime);
}

void AG2SimPlayerController::UpdateLook(float DeltaTime)
{
	float Dx = 0.f, Dy = 0.f;
	GetInputMouseDelta(Dx, Dy);

	float Target = 0.f;
	if (IsInputKeyDown(EKeys::Q)) Target -= MaxRoll;
	if (IsInputKeyDown(EKeys::E)) Target += MaxRoll;
	HeadRoll = FMath::FInterpConstantTo(HeadRoll, Target, DeltaTime, RollSpeed);

	FRotator R = GetControlRotation();
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
		C->GetCharacterMovement()->MaxWalkSpeed = IsInputKeyDown(EKeys::LeftShift) ? AG2SimCharacter::RunSpeed : AG2SimCharacter::WalkSpeed;
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
	if (WasInputKeyJustPressed(EKeys::F) && !bLongPressing)
	{
		bLongPressing = true;
		LongPressSource = Source;
		Gesture(EG2Gesture::LongStart);
	}

	if (WasInputKeyJustPressed(EKeys::RightMouseButton) || WasInputKeyJustPressed(EKeys::C))
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
	if (WasInputKeyJustPressed(EKeys::MouseScrollUp) || WasInputKeyJustPressed(EKeys::Up)) MenuIndex = (MenuIndex + N - 1) % N;
	if (WasInputKeyJustPressed(EKeys::MouseScrollDown) || WasInputKeyJustPressed(EKeys::Down)) MenuIndex = (MenuIndex + 1) % N;
	if (WasInputKeyJustPressed(EKeys::LeftMouseButton) || WasInputKeyJustPressed(EKeys::Enter))
	{
		const FG2MenuItem& Item = Hub->GetMenu()[MenuIndex];
		Hub->SendMenu(Item.Id);
		Note(FString::Printf(TEXT("menu: %s"), *Item.Label));
		bMenuOpen = false;
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
	const FRotator R = GetControlRotation();
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
