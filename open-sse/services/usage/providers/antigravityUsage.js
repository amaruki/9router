import { CLIENT_METADATA, getPlatformUserAgent } from "../../../config/appConstants.js";
import { proxyAwareFetch } from "../../../utils/proxyFetch.js";
import { parseResetTime } from "../shared/time.js";

const ANTIGRAVITY_CONFIG = {
  quotaApiUrl: "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  loadProjectApiUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  userAgent: getPlatformUserAgent(),
};

const IMPORTANT_MODELS = [
  "gemini-3-flash-agent",
  "gemini-3.5-flash-low",
  "gemini-pro-agent",
  "gemini-3.1-pro-low",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
  "gemini-3-flash",
];

async function getAntigravitySubscriptionInfo(accessToken, proxyOptions = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await proxyAwareFetch(ANTIGRAVITY_CONFIG.loadProjectApiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
        "x-request-source": "local",
      },
      body: JSON.stringify({ metadata: CLIENT_METADATA, mode: 1 }),
      signal: controller.signal,
    }, proxyOptions);

    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("[Antigravity Subscription] Error:", error.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getAntigravityUsage(accessToken, providerSpecificData, proxyOptions = null) {
  try {
    const subscriptionInfo = await getAntigravitySubscriptionInfo(accessToken, proxyOptions);
    const projectId = subscriptionInfo?.cloudaicompanionProject || null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
      response = await proxyAwareFetch(ANTIGRAVITY_CONFIG.quotaApiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
          "Content-Type": "application/json",
          "X-Client-Name": "antigravity",
          "X-Client-Version": "1.107.0",
          "x-request-source": "local",
        },
        body: JSON.stringify({ ...(projectId ? { project: projectId } : {}) }),
        signal: controller.signal,
      }, proxyOptions);
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 403) {
      return { message: "Antigravity quota API access forbidden. Chat may still work.", quotas: {} };
    }
    if (response.status === 401) {
      return { message: "Antigravity quota API authentication expired. Chat may still work.", quotas: {} };
    }
    if (!response.ok) {
      throw new Error(`Antigravity API error: ${response.status}`);
    }

    const data = await response.json();
    const quotas = {};

    if (data.models) {
      for (const [modelKey, info] of Object.entries(data.models)) {
        if (!info.quotaInfo || info.isInternal || !IMPORTANT_MODELS.includes(modelKey)) {
          continue;
        }

        const remainingFraction = info.quotaInfo.remainingFraction || 0;
        const remainingPercentage = remainingFraction * 100;
        const total = 1000;
        const remaining = Math.round(total * remainingFraction);
        const used = total - remaining;

        quotas[modelKey] = {
          used,
          total,
          resetAt: parseResetTime(info.quotaInfo.resetTime),
          remainingPercentage,
          unlimited: false,
          displayName: info.displayName || modelKey,
        };
      }
    }

    return {
      plan: subscriptionInfo?.currentTier?.name || "Unknown",
      quotas,
      subscriptionInfo,
    };
  } catch (error) {
    console.error("[Antigravity Usage] Error:", error.message, error.cause);
    return { message: `Antigravity error: ${error.message}` };
  }
}
