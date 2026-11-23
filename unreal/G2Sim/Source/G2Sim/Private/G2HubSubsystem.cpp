#include "G2HubSubsystem.h"

#include "Containers/Ticker.h"
#include "Dom/JsonObject.h"
#include "Engine/Texture2D.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "IWebSocket.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "WebSocketsModule.h"

DEFINE_LOG_CATEGORY_STATIC(LogG2Hub, Log, All);

namespace
{
	constexpr int32 DisplayW = 576;
	constexpr int32 DisplayH = 288;
	constexpr float ReconnectSeconds = 2.0f;
}

const TCHAR* UG2HubSubsystem::SourceName(EG2Source Source)
{
	switch (Source)
	{
	case EG2Source::Ring: return TEXT("ring");
	case EG2Source::Left: return TEXT("left");
	default: return TEXT("right");
	}
}

const TCHAR* UG2HubSubsystem::GestureName(EG2Gesture Gesture)
{
	switch (Gesture)
	{
	case EG2Gesture::Double: return TEXT("double");
	case EG2Gesture::Up: return TEXT("up");
	case EG2Gesture::Down: return TEXT("down");
	case EG2Gesture::LongStart: return TEXT("longStart");
	case EG2Gesture::LongEnd: return TEXT("longEnd");
	default: return TEXT("tap");
	}
}

void UG2HubSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);

	Url = TEXT("ws://127.0.0.1:5173/__emu/ws");
	FParse::Value(FCommandLine::Get(), TEXT("hub="), Url);

	DisplayTexture = UTexture2D::CreateTransient(DisplayW, DisplayH, PF_B8G8R8A8, TEXT("G2Display"));
	DisplayTexture->SRGB = true;
	DisplayTexture->Filter = TF_Bilinear;
	DisplayTexture->UpdateResource();

	FModuleManager::LoadModuleChecked<FWebSocketsModule>(TEXT("WebSockets"));
	Connect();
}

void UG2HubSubsystem::Deinitialize()
{
	bShuttingDown = true;
	FTSTicker::RemoveTicker(ReconnectHandle);
	if (Socket)
	{
		Socket->OnConnected().Clear();
		Socket->OnConnectionError().Clear();
		Socket->OnClosed().Clear();
		Socket->OnMessage().Clear();
		Socket->OnBinaryMessage().Clear();
		Socket->Close();
		Socket.Reset();
	}
	Super::Deinitialize();
}

void UG2HubSubsystem::Connect()
{
	if (bShuttingDown)
	{
		return;
	}
	Socket = FWebSocketsModule::Get().CreateWebSocket(Url, TEXT(""));

	// Callbacks run on the game thread. Use a weak pointer: the socket may
	// outlive this subsystem by a frame while closing.
	TWeakObjectPtr<UG2HubSubsystem> Weak(this);
	Socket->OnConnected().AddLambda([Weak]()
	{
		if (UG2HubSubsystem* Self = Weak.Get())
		{
			Self->bConnected = true;
			UE_LOG(LogG2Hub, Log, TEXT("Connected to %s"), *Self->Url);
		}
	});
	Socket->OnConnectionError().AddLambda([Weak](const FString& Error)
	{
		if (UG2HubSubsystem* Self = Weak.Get())
		{
			UE_LOG(LogG2Hub, Verbose, TEXT("Connection error: %s"), *Error);
			Self->bConnected = false;
			Self->ScheduleReconnect();
		}
	});
	Socket->OnClosed().AddLambda([Weak](int32 Code, const FString& Reason, bool bClean)
	{
		if (UG2HubSubsystem* Self = Weak.Get())
		{
			UE_LOG(LogG2Hub, Log, TEXT("Closed (%d %s)"), Code, *Reason);
			Self->bConnected = false;
			Self->bAppConnected = false;
			Self->ScheduleReconnect();
		}
	});
	Socket->OnMessage().AddLambda([Weak](const FString& Message)
	{
		if (UG2HubSubsystem* Self = Weak.Get())
		{
			Self->HandleText(Message);
		}
	});
	Socket->OnBinaryMessage().AddLambda([Weak](const void* Data, SIZE_T Size, bool bIsLastFragment)
	{
		UG2HubSubsystem* Self = Weak.Get();
		if (!Self)
		{
			return;
		}
		Self->BinaryBuffer.Append(static_cast<const uint8*>(Data), static_cast<int32>(Size));
		if (bIsLastFragment)
		{
			Self->HandlePng(Self->BinaryBuffer);
			Self->BinaryBuffer.Reset();
		}
	});
	Socket->Connect();
}

void UG2HubSubsystem::ScheduleReconnect()
{
	if (bShuttingDown || ReconnectHandle.IsValid())
	{
		return;
	}
	BinaryBuffer.Reset();
	ReconnectHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateWeakLambda(this, [this](float)
	{
		ReconnectHandle.Reset();
		Connect();
		return false; // one-shot
	}), ReconnectSeconds);
}

void UG2HubSubsystem::SendJson(const TSharedRef<FJsonObject>& Obj)
{
	if (!Socket || !bConnected)
	{
		return;
	}
	FString Out;
	const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
	FJsonSerializer::Serialize(Obj, Writer);
	Socket->Send(Out);
}

void UG2HubSubsystem::SendGesture(EG2Source Source, EG2Gesture Gesture)
{
	TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetStringField(TEXT("type"), TEXT("input"));
	Obj->SetStringField(TEXT("source"), SourceName(Source));
	Obj->SetStringField(TEXT("gesture"), GestureName(Gesture));
	SendJson(Obj);
}

void UG2HubSubsystem::SendMenu(int32 ItemId)
{
	TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetStringField(TEXT("type"), TEXT("menu"));
	Obj->SetNumberField(TEXT("itemId"), ItemId);
	SendJson(Obj);
}

void UG2HubSubsystem::SendImu(const FVector& PitchYawRoll)
{
	TSharedRef<FJsonObject> Sample = MakeShared<FJsonObject>();
	Sample->SetNumberField(TEXT("x"), FMath::RoundToDouble(PitchYawRoll.X * 100.0) / 100.0);
	Sample->SetNumberField(TEXT("y"), FMath::RoundToDouble(PitchYawRoll.Y * 100.0) / 100.0);
	Sample->SetNumberField(TEXT("z"), FMath::RoundToDouble(PitchYawRoll.Z * 100.0) / 100.0);
	TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetStringField(TEXT("type"), TEXT("imu"));
	Obj->SetStringField(TEXT("mode"), TEXT("external"));
	Obj->SetObjectField(TEXT("sample"), Sample);
	SendJson(Obj);
}

void UG2HubSubsystem::SendLocation(double Lat, double Lon, double HeadingDeg, double SpeedMps)
{
	TSharedRef<FJsonObject> Obj = MakeShared<FJsonObject>();
	Obj->SetStringField(TEXT("type"), TEXT("location"));
	Obj->SetNumberField(TEXT("lat"), Lat);
	Obj->SetNumberField(TEXT("lon"), Lon);
	Obj->SetNumberField(TEXT("heading"), HeadingDeg);
	Obj->SetNumberField(TEXT("speed"), SpeedMps);
	Obj->SetNumberField(TEXT("accuracy"), 5);
	Obj->SetBoolField(TEXT("live"), true);
	SendJson(Obj);
}

void UG2HubSubsystem::HandleText(const FString& Message)
{
	TSharedPtr<FJsonObject> Obj;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Message);
	if (!FJsonSerializer::Deserialize(Reader, Obj) || !Obj.IsValid())
	{
		return;
	}
	const FString Type = Obj->GetStringField(TEXT("type"));
	if (Type == TEXT("hello"))
	{
		int32 Version = 0;
		Obj->TryGetNumberField(TEXT("version"), Version);
		UE_LOG(LogG2Hub, Log, TEXT("Hub protocol v%d"), Version);
	}
	else if (Type == TEXT("state"))
	{
		const TSharedPtr<FJsonObject>* App = nullptr;
		bool bAlive = false;
		Obj->TryGetBoolField(TEXT("connected"), bAlive);
		if (Obj->TryGetObjectField(TEXT("app"), App) && App)
		{
			HandleState(*App, bAlive);
		}
	}
	else if (Type == TEXT("ack"))
	{
		bool bOk = true;
		Obj->TryGetBoolField(TEXT("ok"), bOk);
		if (!bOk)
		{
			UE_LOG(LogG2Hub, Warning, TEXT("Hub rejected a command: %s"), *Message);
		}
	}
}

void UG2HubSubsystem::HandleState(const TSharedPtr<FJsonObject>& App, bool bAppAlive)
{
	bAppConnected = bAppAlive;

	const TSharedPtr<FJsonObject>* Capture = nullptr;
	CaptureKind.Reset();
	if (App->TryGetObjectField(TEXT("capture"), Capture) && Capture && Capture->IsValid())
	{
		(*Capture)->TryGetStringField(TEXT("kind"), CaptureKind);
	}

	Menu.Reset();
	const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
	if (App->TryGetArrayField(TEXT("menu"), Items) && Items)
	{
		for (const TSharedPtr<FJsonValue>& V : *Items)
		{
			const TSharedPtr<FJsonObject>* Item = nullptr;
			if (V.IsValid() && V->TryGetObject(Item) && Item)
			{
				FG2MenuItem M;
				(*Item)->TryGetNumberField(TEXT("id"), M.Id);
				(*Item)->TryGetStringField(TEXT("label"), M.Label);
				Menu.Add(MoveTemp(M));
			}
		}
	}

	auto ReadOn = [&App](const TCHAR* Field, const TCHAR* Key, bool& Out)
	{
		Out = false;
		const TSharedPtr<FJsonObject>* Sub = nullptr;
		if (App->TryGetObjectField(Field, Sub) && Sub && Sub->IsValid())
		{
			(*Sub)->TryGetBoolField(Key, Out);
		}
	};
	ReadOn(TEXT("imu"), TEXT("on"), bImuOn);
	ReadOn(TEXT("location"), TEXT("updating"), bLocationUpdating);
	ReadOn(TEXT("audio"), TEXT("on"), bAudioOn);
}

void UG2HubSubsystem::HandlePng(const TArray<uint8>& Png)
{
	IImageWrapperModule& Module = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
	const TSharedPtr<IImageWrapper> Wrapper = Module.CreateImageWrapper(EImageFormat::PNG);
	if (!Wrapper.IsValid() || !Wrapper->SetCompressed(Png.GetData(), Png.Num()))
	{
		return;
	}
	if (Wrapper->GetWidth() != DisplayW || Wrapper->GetHeight() != DisplayH)
	{
		UE_LOG(LogG2Hub, Warning, TEXT("Unexpected frame size %dx%d"), (int32)Wrapper->GetWidth(), (int32)Wrapper->GetHeight());
		return;
	}
	TArray64<uint8> Raw;
	if (!Wrapper->GetRaw(ERGBFormat::BGRA, 8, Raw) || Raw.Num() != int64(DisplayW) * DisplayH * 4)
	{
		return;
	}

	// The render thread owns the copy until it has uploaded it.
	uint8* Copy = static_cast<uint8*>(FMemory::Malloc(Raw.Num()));
	FMemory::Memcpy(Copy, Raw.GetData(), Raw.Num());
	FUpdateTextureRegion2D* Region = new FUpdateTextureRegion2D(0, 0, 0, 0, DisplayW, DisplayH);
	DisplayTexture->UpdateTextureRegions(0, 1, Region, DisplayW * 4, 4, Copy, [](uint8* Data, const FUpdateTextureRegion2D* Regions)
	{
		FMemory::Free(Data);
		delete Regions;
	});

	++FrameCount;
	LastFrameTime = FPlatformTime::Seconds();
}
