#include "G2SimHUD.h"

#include "Components/SceneComponent.h"
#include "Engine/Canvas.h"
#include "Engine/CanvasRenderTarget2D.h"
#include "G2FaceLayer.h"
#include "HeadMountedDisplayFunctionLibrary.h"
#include "Engine/Engine.h"
#include "Engine/Font.h"
#include "Engine/Texture2D.h"
#include "G2HubSubsystem.h"
#include "G2SimPlayerController.h"

namespace
{
	const FLinearColor Text(0.92f, 0.95f, 0.92f);
	const FLinearColor Dim(0.6f, 0.65f, 0.6f);
	const FLinearColor Good(0.35f, 1.f, 0.45f);
	const FLinearColor Bad(1.f, 0.45f, 0.35f);
	const FLinearColor Accent(0.35f, 1.f, 0.45f);

	constexpr float LayerDistance = 150.f;    // cm in front of the eyes
	constexpr int32 PanelW = 1024, PanelH = 320;
	constexpr float PanelWidthDeg = 34.f;
	constexpr float PanelPitchDeg = -24.f;    // below the line of sight
	constexpr double PanelPeriod = 0.1;       // redraw at 10 Hz
}

AG2SimHUD::AG2SimHUD()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.bTickEvenWhenPaused = true;
}

void AG2SimHUD::BeginPlay()
{
	Super::BeginPlay();
	if (UHeadMountedDisplayFunctionLibrary::IsHeadMountedDisplayEnabled())
	{
		SetupVR();
	}
}

void AG2SimHUD::SetupVR()
{
	bVR = true;
	// Face-locked layers use their relative transform as the offset from the eyes.
	USceneComponent* Root = NewObject<USceneComponent>(this, TEXT("Root"));
	SetRootComponent(Root);
	Root->RegisterComponent();

	GlassesLayer = NewObject<UG2FaceLayer>(this, TEXT("GlassesLayer"));
	GlassesLayer->SetupAttachment(Root);
	GlassesLayer->SetPriority(10);
	GlassesLayer->RegisterComponent();

	PanelTarget = Cast<UCanvasRenderTarget2D>(UCanvasRenderTarget2D::CreateCanvasRenderTarget2D(this, UCanvasRenderTarget2D::StaticClass(), PanelW, PanelH));
	if (PanelTarget)
	{
		PanelTarget->ClearColor = FLinearColor(0.015f, 0.02f, 0.015f, 1.f);
		PanelTarget->OnCanvasRenderTargetUpdate.AddDynamic(this, &AG2SimHUD::DrawPanel);
		PanelLayer = NewObject<UG2FaceLayer>(this, TEXT("PanelLayer"));
		PanelLayer->bNoAlphaChannel = true; // an opaque little screen
		PanelLayer->SetupAttachment(Root);
		PanelLayer->SetPriority(5);
		PanelLayer->RegisterComponent();
		PanelLayer->SetTexture(PanelTarget);
		PanelLayer->Place(LayerDistance, PanelWidthDeg, PanelPitchDeg, float(PanelW) / PanelH);
	}
}

void AG2SimHUD::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (!bVR)
	{
		return;
	}
	AG2SimPlayerController* PC = Cast<AG2SimPlayerController>(GetOwningPlayerController());
	UG2HubSubsystem* Hub = PC ? PC->GetHub() : nullptr;
	if (!PC || !Hub)
	{
		return;
	}

	if (GlassesLayer)
	{
		const bool bShow = PC->bShowGlasses && Hub->GetFrameCount() > 0;
		if (bShow && GlassesLayer->GetTexture() != Hub->GetDisplayTexture())
		{
			GlassesLayer->SetTexture(Hub->GetDisplayTexture());
		}
		GlassesLayer->Place(LayerDistance, PC->VrWidthDeg, PC->VrPitchDeg, 2.f);
		GlassesLayer->SetVisibility(bShow);
	}

	// The panel shows when asked for, while the context menu is open, or briefly after an action.
	const double Now = GetWorld()->GetRealTimeSeconds();
	const bool bRecent = Now - PC->LastActionTime < 1.5;
	if (PanelLayer)
	{
		PanelLayer->SetVisibility(PC->bHelp || PC->bMenuOpen || bRecent || !Hub->IsConnected());
	}
	if (PanelTarget && PanelLayer && PanelLayer->IsVisible() && Now >= NextPanelUpdate)
	{
		NextPanelUpdate = Now + PanelPeriod;
		// Repaint the existing resource: the OpenXR layer caches the texture
		// RHI, so a recreated resource would leave it showing the old one.
		PanelTarget->FastUpdateResource();
		PanelLayer->MarkTextureForUpdate();
	}
}

void AG2SimHUD::DrawPanel(UCanvas* InCanvas, int32 Width, int32 Height)
{
	AG2SimPlayerController* PC = Cast<AG2SimPlayerController>(GetOwningPlayerController());
	UG2HubSubsystem* Hub = PC ? PC->GetHub() : nullptr;
	if (!InCanvas || !PC || !Hub)
	{
		return;
	}
	UFont* Font = GEngine->GetLargeFont();
	const float S = 1.4f;
	const float LineH = 34.f;
	auto Line = [&](const FString& T, const FLinearColor& Color, float X, float Y)
	{
		InCanvas->SetDrawColor(Color.ToFColor(true));
		InCanvas->DrawText(Font, T, X, Y, S, S);
	};

	const bool bHub = Hub->IsConnected();
	const bool bApp = bHub && Hub->IsAppConnected();
	Line(FString::Printf(TEXT("Source: %s%s"), UG2HubSubsystem::SourceName(PC->Source), PC->bLongPressing ? TEXT("  [long press]") : TEXT("")), Accent, 24, 16);
	Line(FString::Printf(TEXT("Hub %s   App %s   IMU %s   GPS %s"),
		bHub ? TEXT("ok") : TEXT("offline"), bApp ? TEXT("running") : TEXT("-"),
		Hub->IsImuOn() ? TEXT("on") : TEXT("off"), Hub->IsLocationUpdating() ? TEXT("on") : TEXT("off")),
		bHub && bApp ? Text : Bad, 24, 16 + LineH);

	float Y = 16 + LineH * 2.4f;
	if (PC->bMenuOpen)
	{
		const TArray<FG2MenuItem>& Menu = Hub->GetMenu();
		for (int32 I = 0; I < Menu.Num() && Y < Height - LineH; ++I, Y += LineH)
		{
			const bool bSel = I == PC->MenuIndex;
			if (bSel)
			{
				FCanvasTileItem Tile(FVector2D(16, Y - 2), FVector2D(Width - 32, LineH), FLinearColor(0.15f, 0.5f, 0.2f, 1.f));
				InCanvas->DrawItem(Tile);
			}
			Line(Menu[I].Label, bSel ? Good : Text, 32, Y);
		}
	}
	else if (!bHub)
	{
		Line(FString::Printf(TEXT("Waiting for %s"), *Hub->GetUrl()), Bad, 24, Y);
		Line(TEXT("Run npm run dev and npm run simulate"), Dim, 24, Y + LineH);
	}
	else
	{
		if (GetWorld()->GetRealTimeSeconds() - PC->LastActionTime < 1.5)
		{
			Line(PC->LastAction, Good, 24, Y);
		}
		Line(TEXT("Trigger tap  Stick swipe / turn  A double  B hold long"), Dim, 24, Height - LineH * 2.2f);
		Line(TEXT("Grip menu  X source  Y panel  L-grip+stick display"), Dim, 24, Height - LineH * 1.2f);
	}
}

void AG2SimHUD::Panel(float X, float Y, float W, float H)
{
	DrawRect(FLinearColor(0.f, 0.f, 0.f, 0.55f), X, Y, W, H);
}

void AG2SimHUD::DrawHUD()
{
	Super::DrawHUD();
	AG2SimPlayerController* PC = Cast<AG2SimPlayerController>(GetOwningPlayerController());
	UG2HubSubsystem* Hub = PC ? PC->GetHub() : nullptr;
	if (!PC || !Hub || !Canvas || bVR)
	{
		return; // in VR everything is on the stereo layers
	}
	if (PC->bShowGlasses)
	{
		DrawGlasses(PC, Hub);
	}
	if (PC->bMenuOpen)
	{
		DrawMenu(PC, Hub);
	}
	if (PC->bHelp)
	{
		DrawHelp();
	}
	DrawStatus(PC, Hub);
}

void AG2SimHUD::DrawGlasses(AG2SimPlayerController* PC, UG2HubSubsystem* Hub)
{
	UTexture2D* Tex = Hub->GetDisplayTexture();
	if (!Tex || Hub->GetFrameCount() == 0)
	{
		return;
	}
	const float W = Canvas->SizeX * PC->DisplayWidth;
	const float H = W / 2.f; // 576 x 288
	const float X = (Canvas->SizeX - W) / 2.f;
	const float Y = Canvas->SizeY * PC->DisplayCenterY - H / 2.f;

	// Soft glow: a few faint offset copies, then the sharp image.
	const float G = FMath::Max(1.5f, W / 576.f * 1.5f);
	const FVector2D Offsets[] = { {-G, 0}, {G, 0}, {0, -G}, {0, G} };
	for (const FVector2D& O : Offsets)
	{
		DrawTexture(Tex, X + O.X, Y + O.Y, W, H, 0, 0, 1, 1, FLinearColor(0.6f, 1.f, 0.6f, 0.18f), BLEND_Translucent);
	}
	DrawTexture(Tex, X, Y, W, H, 0, 0, 1, 1, FLinearColor(0.85f, 1.f, 0.85f, 0.95f), BLEND_Translucent);
}

void AG2SimHUD::DrawStatus(AG2SimPlayerController* PC, UG2HubSubsystem* Hub)
{
	UFont* Font = GEngine->GetSmallFont();
	const float S = FMath::Max(1.f, Canvas->SizeY / 1080.f);
	const float LineH = 18.f * S;
	const float Y0 = Canvas->SizeY - LineH * 2.6f;
	Panel(0, Y0 - 6 * S, Canvas->SizeX, Canvas->SizeY - Y0 + 6 * S);

	const bool bHub = Hub->IsConnected();
	const bool bApp = bHub && Hub->IsAppConnected();
	const bool bFrames = Hub->GetFrameCount() > 0;
	FString Line1 = FString::Printf(TEXT("Hub %s   App %s   Display %s   Source: %s%s"),
		bHub ? TEXT("connected") : TEXT("offline"),
		bApp ? TEXT("running") : TEXT("not reporting"),
		bFrames ? *FString::Printf(TEXT("%d frames"), Hub->GetFrameCount()) : TEXT("no frames"),
		UG2HubSubsystem::SourceName(PC->Source),
		PC->bLongPressing ? TEXT("   [long press]") : TEXT(""));
	DrawText(Line1, bHub && bApp && bFrames ? Good : Bad, 12 * S, Y0, Font, S);

	FString Line2 = FString::Printf(TEXT("IMU %s  (pitch %.0f  yaw %.0f  roll %.0f)   GPS %s  %.6f, %.6f   Mic %s   Capture: %s"),
		Hub->IsImuOn() ? TEXT("streaming") : TEXT("off"), PC->LastImu.X, PC->LastImu.Y, PC->LastImu.Z,
		Hub->IsLocationUpdating() ? TEXT("updating") : TEXT("idle"), PC->Lat, PC->Lon,
		Hub->IsAudioOn() ? TEXT("on (PC mic in simulator)") : TEXT("off"),
		Hub->GetCaptureKind().IsEmpty() ? TEXT("-") : *Hub->GetCaptureKind());
	DrawText(Line2, Dim, 12 * S, Y0 + LineH, Font, S);

	if (!bHub)
	{
		UFont* Big = GEngine->GetMediumFont();
		const FString Msg = FString::Printf(TEXT("Waiting for the emulator hub at %s\nRun `npm run dev` and `npm run simulate` in the repo, then this connects by itself."), *Hub->GetUrl());
		float TW = 0, TH = 0;
		GetTextSize(Msg, TW, TH, Big, S);
		Panel((Canvas->SizeX - TW) / 2 - 16 * S, Canvas->SizeY * 0.4f - 12 * S, TW + 32 * S, TH + 24 * S);
		DrawText(Msg, Text, (Canvas->SizeX - TW) / 2, Canvas->SizeY * 0.4f, Big, S);
	}

	const double Age = GetWorld()->GetRealTimeSeconds() - PC->LastActionTime;
	if (Age < 1.5 && !PC->LastAction.IsEmpty())
	{
		UFont* Big = GEngine->GetMediumFont();
		float TW = 0, TH = 0;
		GetTextSize(PC->LastAction, TW, TH, Big, S);
		const float A = Age < 1.0 ? 1.f : float(1.0 - (Age - 1.0) / 0.5);
		const float X = (Canvas->SizeX - TW) / 2, Y = Y0 - TH - 24 * S;
		DrawRect(FLinearColor(0, 0, 0, 0.55f * A), X - 10 * S, Y - 4 * S, TW + 20 * S, TH + 8 * S);
		DrawText(PC->LastAction, FLinearColor(Accent.R, Accent.G, Accent.B, A), X, Y, Big, S);
	}

	if (PC->bMouseFree)
	{
		DrawText(TEXT("Mouse released - click to resume"), Text, 12 * S, 12 * S, GEngine->GetMediumFont(), S);
	}
}

void AG2SimHUD::DrawHelp()
{
	static const TCHAR* Lines[] = {
		TEXT("G2 Simulator"),
		TEXT("Mouse  look        WASD  walk    Shift  run    Q / E  tilt head"),
		TEXT("Left click  tap    Wheel or Up / Down  swipe    X  double tap"),
		TEXT("Hold F  long press      1 / 2 / 3 or Tab  right temple / ring / left temple"),
		TEXT("Right click or C  context menu (wheel, click)"),
		TEXT("G  glasses on/off   [ ]  size   PgUp / PgDn  height   H  this help   Esc  free mouse"),
	};
	UFont* Font = GEngine->GetSmallFont();
	const float S = FMath::Max(1.f, Canvas->SizeY / 1080.f);
	const float LineH = 18.f * S;
	float MaxW = 0;
	for (const TCHAR* L : Lines)
	{
		float TW = 0, TH = 0;
		GetTextSize(L, TW, TH, Font, S);
		MaxW = FMath::Max(MaxW, TW);
	}
	Panel(8 * S, 8 * S, MaxW + 24 * S, LineH * UE_ARRAY_COUNT(Lines) + 16 * S);
	for (int32 I = 0; I < UE_ARRAY_COUNT(Lines); ++I)
	{
		DrawText(Lines[I], I == 0 ? Accent : Text, 20 * S, 16 * S + I * LineH, Font, S);
	}
}

void AG2SimHUD::DrawMenu(AG2SimPlayerController* PC, UG2HubSubsystem* Hub)
{
	const TArray<FG2MenuItem>& Menu = Hub->GetMenu();
	UFont* Font = GEngine->GetMediumFont();
	const float S = FMath::Max(1.f, Canvas->SizeY / 1080.f);
	const float LineH = 30.f * S;
	const float W = 420.f * S;
	const float X = Canvas->SizeX - W - 24 * S;
	const float Y = Canvas->SizeY * 0.18f;
	Panel(X, Y, W, LineH * (Menu.Num() + 1) + 20 * S);
	DrawText(TEXT("Context menu"), Dim, X + 16 * S, Y + 10 * S, Font, S);
	for (int32 I = 0; I < Menu.Num(); ++I)
	{
		const bool bSel = I == PC->MenuIndex;
		const float LY = Y + 10 * S + (I + 1) * LineH;
		if (bSel)
		{
			DrawRect(FLinearColor(0.2f, 0.8f, 0.3f, 0.35f), X + 6 * S, LY - 2 * S, W - 12 * S, LineH);
		}
		DrawText(Menu[I].Label, bSel ? Good : Text, X + 16 * S, LY, Font, S);
	}
}
