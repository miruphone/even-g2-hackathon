#include "G2SimCharacter.h"

#include "Camera/CameraComponent.h"
#include "Components/CapsuleComponent.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "HeadMountedDisplayFunctionLibrary.h"

AG2SimCharacter::AG2SimCharacter()
{
	GetCapsuleComponent()->InitCapsuleSize(30.f, 90.f);

	VROrigin = CreateDefaultSubobject<USceneComponent>(TEXT("VROrigin"));
	VROrigin->SetupAttachment(GetCapsuleComponent());
	VROrigin->SetRelativeLocation(FVector(0, 0, -90.f)); // capsule half height

	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(GetCapsuleComponent());
	Camera->SetRelativeLocation(FVector(0, 0, 70.f)); // eyes at ~160 cm
	Camera->bUsePawnControlRotation = true;
	Camera->SetFieldOfView(90.f);

	bUseControllerRotationYaw = true;
	bUseControllerRotationPitch = false;
	bUseControllerRotationRoll = false;

	UCharacterMovementComponent* Move = GetCharacterMovement();
	Move->MaxWalkSpeed = WalkSpeed;
	Move->BrakingDecelerationWalking = 1200.f;
	Move->MaxStepHeight = 30.f;
}

void AG2SimCharacter::SetupVR()
{
	// The HMD supplies the full head rotation; the pawn only carries the
	// thumbstick / snap-turn yaw. Floor-level tracking puts the camera base at
	// the bottom of the capsule, so the user's real height applies.
	Camera->bUsePawnControlRotation = false;
	Camera->bLockToHmd = true;
	VROrigin->SetRelativeLocation(FVector(0, 0, -GetCapsuleComponent()->GetUnscaledCapsuleHalfHeight()));
	Camera->AttachToComponent(VROrigin, FAttachmentTransformRules::SnapToTargetNotIncludingScale);
	Camera->SetRelativeTransform(FTransform::Identity);
	UHeadMountedDisplayFunctionLibrary::SetTrackingOrigin(EHMDTrackingOrigin::LocalFloor);
}
