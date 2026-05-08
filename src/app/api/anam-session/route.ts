import { NextResponse } from "next/server";

/**
 * Creates an Anam session token with ElevenLabs agent settings.
 *
 * Fetches the ElevenLabs signed URL server-side, then passes it to
 * the Anam session token API via environment.elevenLabsAgentSettings.
 * The engine handles the ElevenLabs connection — the client just
 * streams the avatar video.
 */
export async function POST(request: Request) {
  const anamApiKey = process.env.ANAM_API_KEY?.trim();
  if (!anamApiKey) {
    return NextResponse.json(
      { error: "ANAM_API_KEY must be set" },
      { status: 500 }
    );
  }

  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!elevenLabsApiKey) {
    return NextResponse.json(
      { error: "ELEVENLABS_API_KEY must be set" },
      { status: 500 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const { avatarId, agentId, trainerContext, trainerGoal } = body;


  if (!avatarId) {
    return NextResponse.json(
      { error: "avatarId is required" },
      { status: 400 }
    );
  }
  if (!agentId) {
    return NextResponse.json(
      { error: "agentId is required" },
      { status: 400 }
    );
  }

  // Fetch ElevenLabs signed URL
  const elRes = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
    {
      headers: { "xi-api-key": elevenLabsApiKey },
    }
  );

  if (!elRes.ok) {
    const text = await elRes.text();
    return NextResponse.json(
      { error: `ElevenLabs API error: ${elRes.status} ${text}` },
      { status: elRes.status }
    );
  }

  const { signed_url: signedUrl } = await elRes.json();

  // Create Anam session token with ElevenLabs agent settings
  const anamApiUrl = process.env.ANAM_API_URL || "https://api.anam.ai";
  // Anam phân biệt 2 loại ID:
  //   - avatarId  : lấy từ lab.anam.ai/avatars  (avatar gốc)
  //   - personaId : lấy từ lab.anam.ai/personas (persona đã tạo sẵn)
  // Hiện UUID trong .env là persona ID nên gửi như personaConfig.personaId.
  // Nếu sau này bạn dán avatar ID thật từ trang Avatars vào env, đổi key
  // dưới thành { avatarId }.
  const personaConfig = { personaId: avatarId };

  // Gom dynamic variables để truyền sang ElevenLabs. Agent trên dashboard
  // ElevenLabs phải có placeholder {{trainer_context}} và {{trainer_goal}}
  // trong system prompt mới sử dụng được các giá trị này.
  const ctx =
    typeof trainerContext === "string" ? trainerContext.trim() : "";
  const goal = typeof trainerGoal === "string" ? trainerGoal.trim() : "";

  const dynamicVariables: Record<string, string> = {};
  if (ctx) dynamicVariables.trainer_context = ctx;
  if (goal) dynamicVariables.trainer_goal = goal;

  // Ghi đè first_message để AI luôn mở lời trước (mặc định ElevenLabs đợi
  // user nói trước nếu first_message trống). Agent của bạn cho phép override
  // này (xem platform_settings.overrides.agent.first_message = true).
  // Dùng câu mở "kích hoạt" chung; LLM sẽ tự cụ thể hoá theo trainer_context
  // ở các câu tiếp theo.
  const conversationConfigOverride = {
    agent: {
      first_message:
        "A lô! Tôi vừa mua sản phẩm của công ty các anh chị mà gặp vấn đề rất nghiêm trọng. Anh/chị nghe tôi nói đây.",
    },
  };

  const sessionTokenBody = {
    personaConfig,
    environment: {
      elevenLabsAgentSettings: {
        signedUrl,
        agentId,
        ...(Object.keys(dynamicVariables).length > 0 && { dynamicVariables }),
        conversationConfigOverride,
      },
      ...(process.env.ANAM_POD_NAME && {
        podName: process.env.ANAM_POD_NAME,
      }),
    },
  };
  console.log(
    "Creating session token:",
    `${anamApiUrl}/v1/auth/session-token`,
    JSON.stringify(sessionTokenBody, null, 2)
  );
  const anamRes = await fetch(`${anamApiUrl}/v1/auth/session-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anamApiKey}`,
    },
    body: JSON.stringify(sessionTokenBody),
  });

  if (!anamRes.ok) {
    const text = await anamRes.text();
    return NextResponse.json(
      { error: `Anam API error: ${anamRes.status} ${text}` },
      { status: anamRes.status }
    );
  }

  const data = await anamRes.json();

  // Debug: decode the JWT payload to check token type
  try {
    const payload = JSON.parse(
      Buffer.from(data.sessionToken.split(".")[1], "base64").toString()
    );
    console.log("Session token payload:", JSON.stringify(payload, null, 2));
  } catch {}

  return NextResponse.json({ sessionToken: data.sessionToken });
}
