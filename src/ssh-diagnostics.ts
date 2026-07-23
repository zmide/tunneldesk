export interface SshDiagnosis {
  reason: string;
  message: string;
  suggestions: string[];
  display: string;
}

export function diagnoseSshError(message: unknown): SshDiagnosis {
  const text = String(message || "").trim();
  const lower = text.toLowerCase();
  const suggestions: string[] = [];
  let reason = "SSH 操作失败";
  if (/unprotected private key|bad permissions|permissions.*too open/.test(lower)) {
    reason = "私钥权限过宽";
    suggestions.push("在密钥管理中执行一键修复权限。", "Windows 下确保私钥只允许当前用户、SYSTEM 或 Administrators 读取。");
  } else if (/permission denied/.test(lower)) {
    reason = "SSH 认证失败";
    suggestions.push("检查用户名、私钥是否正确。", "确认服务器允许该用户使用公钥登录。");
  } else if (/connection timed out|operation timed out|connecttimeout/.test(lower)) {
    reason = "连接超时";
    suggestions.push("检查主机地址、端口、防火墙和网络连通性。");
  } else if (/connection refused/.test(lower)) {
    reason = "连接被拒绝";
    suggestions.push("检查 SSH 服务是否运行，以及端口是否正确。");
  } else if (/could not resolve hostname|name or service not known|getaddrinfo/.test(lower)) {
    reason = "主机名解析失败";
    suggestions.push("检查 SSH 主机名或 DNS 配置。");
  } else if (/address already in use|bind.*failed|端口已被占用|listen.*eaddrinuse/.test(lower)) {
    reason = "监听端口被占用";
    suggestions.push("更换本地监听端口，或停止占用该端口的程序。");
  } else if (/remote port forwarding failed|administratively prohibited/.test(lower)) {
    reason = "远程转发被服务器拒绝";
    suggestions.push("检查服务器 sshd_config 是否允许 AllowTcpForwarding。", "远程转发还可能需要 GatewayPorts 配置。");
  } else if (/no such file|identity file.*not accessible/.test(lower)) {
    reason = "私钥文件不存在或不可访问";
    suggestions.push("重新上传私钥，或在连接配置中选择正确的私钥。");
  } else if (/host key verification failed/.test(lower)) {
    reason = "主机指纹校验失败";
    suggestions.push("确认服务器指纹变化是否可信。", "必要时清理 known_hosts 中旧记录。");
  }
  return {
    reason,
    message: text,
    suggestions,
    display: [reason, text, ...suggestions.map(item => `建议：${item}`)].filter(Boolean).join("\n")
  };
}
