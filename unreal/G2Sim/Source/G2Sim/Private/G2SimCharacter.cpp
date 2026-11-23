#include "G2SimCharacter.h"

#include "Camera/CameraComponent.h"
#include "Components/CapsuleComponent.h"
#include "GameFramework/CharacterMovementComponent.h"

AG2SimCharacter::AG2SimCharacter()
{
	GetCapsuleComponent()->InitCapsuleSize(30.f, 90.f);

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
