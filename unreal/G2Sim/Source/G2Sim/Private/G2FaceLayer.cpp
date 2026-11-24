#include "G2FaceLayer.h"

UG2FaceLayer::UG2FaceLayer()
{
	StereoLayerType = SLT_FaceLocked;
	bLiveTexture = true; // the textures are updated from the hub / redrawn
	bQuadPreserveTextureRatio = false;
	bSupportsDepth = false;
	bNoAlphaChannel = false;
}

void UG2FaceLayer::Place(float Distance, float WidthDeg, float PitchDeg, float Aspect)
{
	const float Width = 2.f * Distance * FMath::Tan(FMath::DegreesToRadians(WidthDeg) / 2.f);
	const float Pitch = FMath::DegreesToRadians(PitchDeg);
	const FVector Location(Distance * FMath::Cos(Pitch), 0.f, Distance * FMath::Sin(Pitch));
	// Tilt the quad so it stays perpendicular to the line of sight.
	const FTransform T(FRotator(PitchDeg, 0.f, 0.f), Location);
	if (!GetRelativeTransform().Equals(T, 0.01) )
	{
		SetRelativeTransform(T);
	}
	const FVector2D Size(Width, Width / Aspect);
	if (!GetQuadSize().Equals(Size, 0.01))
	{
		SetQuadSize(Size);
	}
}
