#pragma once

#include "CoreMinimal.h"
#include "Components/StereoLayerComponent.h"
#include "G2FaceLayer.generated.h"

/**
 * A head-locked quad composited by the VR runtime (an OpenXR quad layer),
 * not rendered into the scene: text stays sharp and it never drifts, like
 * the waveguide display of the real glasses. Its relative transform is the
 * offset from the eyes (+X forward, cm).
 */
UCLASS()
class G2SIM_API UG2FaceLayer : public UStereoLayerComponent
{
	GENERATED_BODY()

public:
	UG2FaceLayer();

	/** Place the quad `Distance` cm ahead, `PitchDeg` above the view centre, `WidthDeg` wide. */
	void Place(float Distance, float WidthDeg, float PitchDeg, float Aspect);
};
