/** Public processing descriptions; never include a model address or credential. */
export type PlayProcessingKind =
  "ollama" | "private-ollama" | "compatible" | "unavailable";

export function playProcessingKind(
  value: string | undefined,
  explicitBase?: string,
): PlayProcessingKind {
  const kind =
    value?.trim() || (explicitBase?.trim() ? "compatible" : "ollama");
  return kind === "private-ollama" || kind === "compatible" || kind === "ollama"
    ? kind
    : "unavailable";
}

export function playProcessingCopy(
  kind: PlayProcessingKind,
): readonly [string, string] {
  if (kind === "private-ollama")
    return [
      "网页和实验记录保存在项目树莓派。生成回复时，分身参考资料和当前对话经加密连接发送到项目 Mac 的本机模型处理，不使用云端模型。",
      "The website and experiment records are hosted on the project Raspberry Pi. To generate replies, persona references and the current conversation are sent over an encrypted connection to a model running locally on the project Mac. No cloud model is used.",
    ] as const;
  if (kind === "ollama")
    return [
      "分身参考资料和当前对话由运行本网站的设备上的本机模型处理，不使用云端模型。",
      "Persona references and the current conversation are processed by a model running locally on the device hosting this website. No cloud model is used.",
    ] as const;
  if (kind === "compatible")
    return [
      "生成回复时，分身参考资料和当前对话会发送给项目配置的模型接口处理。接口可能由外部服务提供；具体服务及数据处理方式请向项目负责人确认。",
      "To generate replies, persona references and the current conversation are sent to the model API configured by the project. This may be an external service; ask the project operator which service is used and how it handles data.",
    ] as const;
  return [
    "模型连接尚未配置完成。开始 AI 聊天前，请向项目负责人确认模型位置和资料处理方式。",
    "The model connection is not configured. Before starting an AI chat, ask the project operator where the model runs and how it processes data.",
  ] as const;
}

export const generatedReplyPolicy = [
  "AI 生成的回复不会自动加入你的表达示例或训练资料；只有你亲自填写并保存的纠正会成为新的参考。",
  "AI replies are not automatically added to your speaking examples or training material. Only corrections you write and save become new references.",
] as const;
