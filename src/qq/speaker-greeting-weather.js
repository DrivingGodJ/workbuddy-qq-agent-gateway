export function parseSpeakerWeatherLocation(value) {
  const [name, lat, lon, ...extra] = String(value || "").split(",").map((part) => part.trim());
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!name || name.length > 40 || !lat || !lon || extra.length || !Number.isFinite(latitude) || Math.abs(latitude) > 90
    || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  return { name, latitude, longitude };
}

export async function speakerWeatherText(location, date, fetchImpl = fetch) {
  const unavailable = "今天的天气暂时查不到。";
  if (!location) return unavailable;
  try {
    const query = new URLSearchParams({
      latitude: String(location.latitude), longitude: String(location.longitude),
      daily: "temperature_2m_min,temperature_2m_max,weather_code,precipitation_probability_max",
      forecast_days: "1", timezone: "Asia/Shanghai"
    });
    const response = await fetchImpl(`https://api.open-meteo.com/v1/forecast?${query}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return unavailable;
    const { daily } = await response.json();
    const index = daily?.time?.indexOf(date) ?? -1;
    if (index < 0) return unavailable;
    const low = daily.temperature_2m_min?.[index];
    const high = daily.temperature_2m_max?.[index];
    if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) return unavailable;

    const code = daily.weather_code?.[index];
    const conditions = { 0: "晴", 1: "大致晴朗", 2: "多云", 3: "阴", 45: "有雾", 48: "有雾", 95: "有雷雨", 96: "有雷雨和冰雹", 99: "有雷雨和冰雹" };
    let condition = conditions[code];
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) condition = "有雨";
    if ([71, 73, 75, 77, 85, 86].includes(code)) condition = "有雪";
    const clothes = low < 5 ? "出门穿厚外套" : low < 12 ? "早晚加件保暖外套"
      : low < 18 ? "带一件薄外套" : high >= 28 ? "穿轻薄透气的衣服" : "穿薄长袖或短袖都可以";
    const umbrella = (daily.precipitation_probability_max?.[index] ?? 0) >= 40 || (condition && /[雨雪]/u.test(condition));
    return `今天${location.name}${condition || ""}，${Math.round(low)}到${Math.round(high)}度。${clothes}${umbrella ? "，出门记得带伞" : ""}。`;
  } catch {
    return unavailable;
  }
}
