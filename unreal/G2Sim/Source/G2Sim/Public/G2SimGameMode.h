#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "G2SimGameMode.generated.h"

class UStaticMesh;
class UMaterialInterface;
class APlayerStart;

/**
 * Game mode for the G2 simulator. When the loaded map is empty (the default
 * /Engine/Maps/Entry), it builds a small procedural city block so the
 * project needs no binary map assets: streets, buildings, a park, sun, sky
 * and fog. A real map with its own geometry is left untouched.
 */
UCLASS()
class G2SIM_API AG2SimGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	AG2SimGameMode();

	virtual AActor* ChoosePlayerStart_Implementation(AController* Player) override;
	virtual void StartPlay() override;

private:
	void BuildSceneIfEmpty();
	AActor* SpawnShape(UStaticMesh* Mesh, const FVector& Location, const FVector& Scale, const FLinearColor& Color, const FRotator& Rotation = FRotator::ZeroRotator);

	UPROPERTY()
	TObjectPtr<UStaticMesh> CubeMesh;
	UPROPERTY()
	TObjectPtr<UStaticMesh> PlaneMesh;
	UPROPERTY()
	TObjectPtr<UStaticMesh> CylinderMesh;
	UPROPERTY()
	TObjectPtr<UStaticMesh> SphereMesh;
	UPROPERTY()
	TObjectPtr<UStaticMesh> ConeMesh;
	UPROPERTY()
	TObjectPtr<UMaterialInterface> ShapeMaterial;

	UPROPERTY()
	TObjectPtr<APlayerStart> Start;

	bool bSceneChecked = false;
};
