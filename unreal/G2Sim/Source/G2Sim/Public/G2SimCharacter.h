#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "G2SimCharacter.generated.h"

class UCameraComponent;

/** First-person walker. The camera follows the controller rotation, roll included (head tilt). */
UCLASS()
class G2SIM_API AG2SimCharacter : public ACharacter
{
	GENERATED_BODY()

public:
	AG2SimCharacter();

	UCameraComponent* GetCamera() const { return Camera; }

	/** Hand the camera to the headset: it follows the HMD pose, standing on the floor. */
	void SetupVR();

	static constexpr float WalkSpeed = 140.f; // cm/s, a natural walk (GPS speed stays realistic)
	static constexpr float RunSpeed = 450.f;

private:
	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UCameraComponent> Camera;

	/** Floor point under the capsule. In VR the camera hangs here, because the
	 *  HMD pose replaces the camera's whole relative transform. */
	UPROPERTY(VisibleAnywhere)
	TObjectPtr<USceneComponent> VROrigin;
};
