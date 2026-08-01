import { describe, expect, it } from "vitest";
import { sanitizeCommandForSummary } from "../src/commandSanitizer.js";

describe("sanitizeCommandForSummary", () => {
  it("keeps an SSH remote operation while hiding its destination", () => {
    expect(
      sanitizeCommandForSummary(
        "ssh root@192.168.0.226 systemctl restart warp-svc",
      ),
    ).toBe("ssh <destination> systemctl restart warp-svc");
  });

  it("removes SSH options and keeps only the remote operation", () => {
    expect(
      sanitizeCommandForSummary(
        "ssh -o StrictHostKeyChecking=no -p 22 root@example.test systemctl status warp-svc",
      ),
    ).toBe("ssh <destination> systemctl status warp-svc");
  });

  it("redacts authorization values and URLs", () => {
    const sanitized = sanitizeCommandForSummary(
      'curl -H "Authorization: Bearer secret-token-123456789" https://private.example/api',
    );

    expect(sanitized).not.toContain("secret-token");
    expect(sanitized).not.toContain("private.example");
    expect(sanitized).toContain("Authorization: <redacted>");
    expect(sanitized).toContain("<url>");
  });

  it("redacts secret environment variables while preserving safe arguments", () => {
    const sanitized = sanitizeCommandForSummary(
      "OPENAI_API_KEY=sk-example123456789 npm test -- --runInBand",
    );

    expect(sanitized).toContain("OPENAI_API_KEY=<redacted>");
    expect(sanitized).toContain("npm test -- --runInBand");
    expect(sanitized).not.toContain("sk-example");
  });

  it("redacts PowerShell environment assignments and basic-auth arguments", () => {
    const sanitized = sanitizeCommandForSummary(
      "$env:ACCESS_TOKEN='private-value'; curl -u user:password https://example.test",
    );

    expect(sanitized).toContain("$env:ACCESS_TOKEN=<redacted>");
    expect(sanitized).toContain("-u=<redacted>");
    expect(sanitized).toContain("<url>");
    expect(sanitized).not.toContain("private-value");
    expect(sanitized).not.toContain("user:password");
  });

  it("redacts absolute paths and long opaque tokens", () => {
    const sanitized = sanitizeCommandForSummary(
      "Get-Content C:\\Users\\someone\\secret.txt abcdefghijklmnopqrstuvwxyz1234567890",
    );

    expect(sanitized).toBe("Get-Content <path> <redacted>");
  });
});
