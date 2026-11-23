#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "G2HubSubsystem.generated.h"

class IWebSocket;
class UTexture2D;

/** Where a touch gesture comes from on the G2 (matches the hub protocol). */
UENUM()
enum class EG2Source : uint8
{
	Right, // right temple touchpad
	Ring,  // R1 ring
	Left,  // left temple touchpad
};

/** Touch gestures the hub understands. */
UENUM()
enum class EG2Gesture : uint8
{
	Tap,
	Double,
	Up,
	Down,
	LongStart,
	LongEnd,
};

struct FG2MenuItem
{
	int32 Id = 0;
	FString Label;
};

/**
 * Connection to the G2 emulator hub (the Vite dev server's /__emu/ws).
 *
 * Receives the glasses framebuffer as PNG frames and the app's state (which
 * container captures input, the context menu, whether IMU / location are on),
 * and sends gestures, menu clicks, head pose (as IMU) and position (as GPS).
 *
 * Hub URL: ws://127.0.0.1:5173/__emu/ws, override with -hub=<url> on the
 * command line.
 */
UCLASS()
class G2SIM_API UG2HubSubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

	/** Latest glasses frame (576x288, alpha = pixel brightness). Null until the first frame. */
	UTexture2D* GetDisplayTexture() const { return DisplayTexture; }

	bool IsConnected() const { return bConnected; }
	bool IsAppConnected() const { return bAppConnected; }
	const FString& GetUrl() const { return Url; }
	int32 GetFrameCount() const { return FrameCount; }
	double GetLastFrameTime() const { return LastFrameTime; }

	bool IsImuOn() const { return bImuOn; }
	bool IsLocationUpdating() const { return bLocationUpdating; }
	bool IsAudioOn() const { return bAudioOn; }
	const FString& GetCaptureKind() const { return CaptureKind; }
	const TArray<FG2MenuItem>& GetMenu() const { return Menu; }

	void SendGesture(EG2Source Source, EG2Gesture Gesture);
	void SendMenu(int32 ItemId);
	/** Head pose in degrees: X = pitch (nod), Y = yaw (shake), Z = roll (tilt). */
	void SendImu(const FVector& PitchYawRoll);
	void SendLocation(double Lat, double Lon, double HeadingDeg, double SpeedMps);

	static const TCHAR* SourceName(EG2Source Source);
	static const TCHAR* GestureName(EG2Gesture Gesture);

private:
	void Connect();
	void ScheduleReconnect();
	void SendJson(const TSharedRef<class FJsonObject>& Obj);
	void HandleText(const FString& Message);
	void HandleState(const TSharedPtr<class FJsonObject>& App, bool bAppAlive);
	void HandlePng(const TArray<uint8>& Png);

	TSharedPtr<IWebSocket> Socket;
	FString Url;
	FTSTicker::FDelegateHandle ReconnectHandle;
	bool bConnected = false;
	bool bShuttingDown = false;

	TArray<uint8> BinaryBuffer;

	UPROPERTY(Transient)
	TObjectPtr<UTexture2D> DisplayTexture;

	int32 FrameCount = 0;
	double LastFrameTime = 0.0;

	bool bAppConnected = false;
	bool bImuOn = false;
	bool bLocationUpdating = false;
	bool bAudioOn = false;
	FString CaptureKind;
	TArray<FG2MenuItem> Menu;
};
