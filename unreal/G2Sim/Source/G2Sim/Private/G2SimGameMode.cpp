#include "G2SimGameMode.h"

#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/ExponentialHeightFog.h"
#include "Engine/SkyLight.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "G2SimCharacter.h"
#include "G2SimHUD.h"
#include "G2SimPlayerController.h"
#include "GameFramework/PlayerStart.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "UObject/ConstructorHelpers.h"

AG2SimGameMode::AG2SimGameMode()
{
	DefaultPawnClass = AG2SimCharacter::StaticClass();
	PlayerControllerClass = AG2SimPlayerController::StaticClass();
	HUDClass = AG2SimHUD::StaticClass();

	// Hard references from the CDO, so the cook includes these engine assets.
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Plane(TEXT("/Engine/BasicShapes/Plane.Plane"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Sphere(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cone(TEXT("/Engine/BasicShapes/Cone.Cone"));
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> Mat(TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	CubeMesh = Cube.Object;
	PlaneMesh = Plane.Object;
	CylinderMesh = Cylinder.Object;
	SphereMesh = Sphere.Object;
	ConeMesh = Cone.Object;
	ShapeMaterial = Mat.Object;
}

AActor* AG2SimGameMode::ChoosePlayerStart_Implementation(AController* Player)
{
	// The pawn is spawned before StartPlay, so build the scene here first.
	BuildSceneIfEmpty();
	return Start ? Start.Get() : Super::ChoosePlayerStart_Implementation(Player);
}

void AG2SimGameMode::StartPlay()
{
	BuildSceneIfEmpty();
	Super::StartPlay();
}

AActor* AG2SimGameMode::SpawnShape(UStaticMesh* Mesh, const FVector& Location, const FVector& Scale, const FLinearColor& Color, const FRotator& Rotation)
{
	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	AStaticMeshActor* Actor = GetWorld()->SpawnActor<AStaticMeshActor>(Location, Rotation, Params);
	UStaticMeshComponent* Comp = Actor->GetStaticMeshComponent();
	Comp->SetMobility(EComponentMobility::Movable);
	Comp->SetStaticMesh(Mesh);
	Comp->SetWorldScale3D(Scale);
	UMaterialInstanceDynamic* Mid = UMaterialInstanceDynamic::Create(ShapeMaterial, Actor);
	Mid->SetVectorParameterValue(TEXT("Color"), Color);
	Comp->SetMaterial(0, Mid);
	Actor->Tags.Add(TEXT("G2SimProcedural"));
	return Actor;
}

void AG2SimGameMode::BuildSceneIfEmpty()
{
	if (bSceneChecked)
	{
		return;
	}
	bSceneChecked = true;
	UWorld* World = GetWorld();

	for (TActorIterator<APlayerStart> It(World); It; ++It)
	{
		Start = *It;
	}
	for (TActorIterator<AStaticMeshActor> It(World); It; ++It)
	{
		return; // the map has its own geometry
	}
	if (!CubeMesh || !PlaneMesh || !ShapeMaterial)
	{
		return;
	}

	// Units: 1 uu = 1 cm. +X = north, +Y = east (see the GPS mapping in the controller).
	const float Block = 6000.f;  // 60 m between street centre lines
	const float Street = 1400.f; // 14 m wide streets
	const int32 Blocks = 4;      // 4x4 blocks around the origin
	const float Half = Blocks * Block / 2.f;

	// Ground and asphalt.
	SpawnShape(PlaneMesh, FVector(0, 0, -1), FVector(Half * 3 / 100.f, Half * 3 / 100.f, 1), FLinearColor(0.08f, 0.12f, 0.06f));
	SpawnShape(PlaneMesh, FVector::ZeroVector, FVector(Half * 2 / 100.f, Half * 2 / 100.f, 1), FLinearColor(0.035f, 0.035f, 0.04f));

	FRandomStream Rng(20261123);
	for (int32 I = 0; I < Blocks; ++I)
	{
		for (int32 J = 0; J < Blocks; ++J)
		{
			const FVector2D C(-Half + Block * (I + 0.5f), -Half + Block * (J + 0.5f));
			const float Size = Block - Street;
			// Sidewalk slab.
			SpawnShape(CubeMesh, FVector(C.X, C.Y, 7.5f), FVector(Size / 100.f, Size / 100.f, 0.15f), FLinearColor(0.35f, 0.35f, 0.33f));

			const bool bPark = (I == 1 && J == 2);
			if (bPark)
			{
				SpawnShape(CubeMesh, FVector(C.X, C.Y, 16.f), FVector((Size - 600) / 100.f, (Size - 600) / 100.f, 0.02f), FLinearColor(0.05f, 0.25f, 0.04f));
				for (int32 T = 0; T < 9; ++T)
				{
					const FVector P(C.X + Rng.FRandRange(-Size / 3, Size / 3), C.Y + Rng.FRandRange(-Size / 3, Size / 3), 0);
					SpawnShape(CylinderMesh, P + FVector(0, 0, 165), FVector(0.35f, 0.35f, 3.f), FLinearColor(0.15f, 0.09f, 0.05f));
					SpawnShape(SphereMesh, P + FVector(0, 0, 420), FVector(3.2f), FLinearColor(0.06f, 0.3f, 0.06f));
				}
				continue;
			}

			// 2x2 buildings per block with random heights.
			const float Lot = Size / 2.f;
			for (int32 A = 0; A < 2; ++A)
			{
				for (int32 B = 0; B < 2; ++B)
				{
					const float W = Lot - Rng.FRandRange(300.f, 700.f);
					const float D = Lot - Rng.FRandRange(300.f, 700.f);
					const float H = Rng.FRandRange(900.f, 5200.f);
					const FVector P(C.X - Lot / 2 + A * Lot, C.Y - Lot / 2 + B * Lot, 15.f + H / 2);
					const float G = Rng.FRandRange(0.25f, 0.7f);
					const FLinearColor Col(G, G * Rng.FRandRange(0.9f, 1.f), G * Rng.FRandRange(0.85f, 1.05f));
					SpawnShape(CubeMesh, P, FVector(W / 100.f, D / 100.f, H / 100.f), Col);
				}
			}
		}
	}

	// Street furniture: lamp posts and traffic cones along the main avenue (X axis).
	for (int32 K = -8; K <= 8; ++K)
	{
		const float X = K * 1500.f;
		SpawnShape(CylinderMesh, FVector(X, 620.f, 250.f), FVector(0.12f, 0.12f, 5.f), FLinearColor(0.1f, 0.1f, 0.1f));
		SpawnShape(SphereMesh, FVector(X, 620.f, 510.f), FVector(0.4f), FLinearColor(1.f, 0.9f, 0.6f));
	}
	for (int32 K = 0; K < 5; ++K)
	{
		SpawnShape(ConeMesh, FVector(1200.f + K * 250.f, -300.f, 40.f), FVector(0.4f, 0.4f, 0.8f), FLinearColor(1.f, 0.3f, 0.02f));
	}
	// Invisible walls around the ground so nobody walks off the edge.
	const float Edge = Half * 1.5f;
	for (int32 Side = 0; Side < 4; ++Side)
	{
		const bool bX = Side < 2;
		const float Sign = (Side % 2 == 0) ? 1.f : -1.f;
		const FVector P = bX ? FVector(Sign * Edge, 0, 500.f) : FVector(0, Sign * Edge, 500.f);
		const FVector Scale = bX ? FVector(1.f, Edge * 2 / 100.f, 10.f) : FVector(Edge * 2 / 100.f, 1.f, 10.f);
		AActor* Wall = SpawnShape(CubeMesh, P, Scale, FLinearColor::Black);
		Wall->SetActorHiddenInGame(true);
	}

	// A landmark tower to the north, so the heading is easy to read.
	SpawnShape(CylinderMesh, FVector(Half + 2500.f, 0, 6000.f), FVector(12.f, 12.f, 120.f), FLinearColor(0.8f, 0.15f, 0.1f));

	// Lighting: movable sun + atmosphere + real-time sky light + fog (Lumen).
	FActorSpawnParameters Params;
	ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(FVector(0, 0, 2000), FRotator(-38.f, -35.f, 0), Params);
	Sun->SetMobility(EComponentMobility::Movable);
	if (UDirectionalLightComponent* L = Cast<UDirectionalLightComponent>(Sun->GetLightComponent()))
	{
		L->SetIntensity(8.f);
		L->SetAtmosphereSunLight(true);
	}

	AActor* Sky = World->SpawnActor<AActor>(FVector::ZeroVector, FRotator::ZeroRotator, Params);
	USkyAtmosphereComponent* Atmosphere = NewObject<USkyAtmosphereComponent>(Sky, TEXT("SkyAtmosphere"));
	Sky->SetRootComponent(Atmosphere);
	Atmosphere->RegisterComponent();

	ASkyLight* SkyLight = World->SpawnActor<ASkyLight>(FVector::ZeroVector, FRotator::ZeroRotator, Params);
	if (USkyLightComponent* S = SkyLight->GetLightComponent())
	{
		S->SetMobility(EComponentMobility::Movable);
		S->bRealTimeCapture = true;
		S->SetIntensity(1.f);
		S->RecaptureSky();
	}

	AExponentialHeightFog* Fog = World->SpawnActor<AExponentialHeightFog>(FVector::ZeroVector, FRotator::ZeroRotator, Params);
	if (UExponentialHeightFogComponent* F = Fog->GetComponent())
	{
		F->SetFogDensity(0.008f);
		F->SetFogHeightFalloff(0.2f);
	}

	if (!Start)
	{
		// Street corner at the origin, looking north up the avenue.
		Start = World->SpawnActor<APlayerStart>(FVector(-Block / 2.f + 300.f, 0, 120.f), FRotator::ZeroRotator, Params);
	}
}
