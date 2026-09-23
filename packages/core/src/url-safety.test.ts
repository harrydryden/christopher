/**
 * The address rule the worker and the interface share: http(s) only, no credentials, and nothing on
 * a private, loopback, link-local or otherwise local network, however the address is spelled.
 */
import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, isIpLiteral, isPublicAddress, UnsafeUrlError } from "./url-safety";

describe("isPublicAddress", () => {
  it.each([
    "0.0.0.0", "0.1.2.3", "10.0.0.5", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.8.9.10",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.168.1.1",
    "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250",
    "240.0.0.1", "255.255.255.255",
  ])("refuses the IPv4 address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "::", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe",
    "::ffff:10.0.0.1", "::127.0.0.1", "64:ff9b::a00:1", "64:ff9b::10.0.0.1", "2002:7f00:1::", "2002:c0a8:101::1",
    "fc00::1", "fd12:3456:789a::1", "fe80::1", "fe80::1%eth0", "fec0::1", "ff02::1", "100::1",
    "2001::1", "2001:db8::1", "2001:10::1", "2001:20::1", "64:ff9b:1::1",
  ])("refuses the IPv6 address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "93.184.216.34", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "192.169.0.1",
    "2606:4700:4700::1111", "2a00:1450:4009:81f::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"])(
    "allows the public address %s", (address) => {
      expect(isPublicAddress(address)).toBe(true);
    });

  it("says no to anything that is not an address, so a name can never pass as vetted", () => {
    for (const text of ["", "example.com", "1.2.3", "256.1.1.1", "1:2:3:4:5:6:7:8:9", "::1::", "gggg::1"]) {
      expect(isPublicAddress(text)).toBe(false);
    }
    expect(isIpLiteral("[2606:4700::1]")).toBe(true);
    expect(isIpLiteral("8.8.8.8")).toBe(true);
    expect(isIpLiteral("boards.greenhouse.io")).toBe(false);
  });
});

describe("assertPublicHttpUrl", () => {
  const refused = (url: string) => {
    try {
      assertPublicHttpUrl(url);
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeUrlError);
      return (error as Error).message;
    }
    throw new Error(`${url} was allowed`);
  };

  it("allows ordinary public careers pages and returns the parsed URL", () => {
    expect(assertPublicHttpUrl("https://boards.greenhouse.io/acme").hostname).toBe("boards.greenhouse.io");
    expect(assertPublicHttpUrl("http://careers.example.com:8080/jobs?x=1").port).toBe("8080");
    expect(assertPublicHttpUrl(new URL("https://8.8.8.8/")).hostname).toBe("8.8.8.8");
    expect(assertPublicHttpUrl("https://[2606:4700:4700::1111]/").hostname).toBe("[2606:4700:4700::1111]");
    expect(assertPublicHttpUrl("https://example.com./").hostname).toBe("example.com.");
  });

  it("refuses every scheme but http and https", () => {
    for (const url of ["file:///etc/passwd", "data:text/html,<h1>hi</h1>", "javascript:alert(1)", "ftp://example.com/", "gopher://example.com/"]) {
      expect(refused(url)).toMatch(/Only http and https/);
    }
  });

  it("refuses credentials in the address", () => {
    expect(refused("https://user:pass@example.com/")).toMatch(/user name or password/);
    expect(refused("https://user@example.com/")).toMatch(/user name or password/);
  });

  it("refuses private and local IP literals however they are spelled", () => {
    for (const url of [
      "http://127.0.0.1:8080/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/", "http://[::1]/",
      "http://[::ffff:127.0.0.1]/", "http://[fd00::1]/", "http://0/", "http://0.0.0.0/",
      // The URL parser canonicalises these to 127.0.0.1 before anything else sees them.
      "http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://127.1/",
    ]) {
      expect(refused(url)).toMatch(/private or local network address/);
    }
  });

  it("refuses names that only ever mean the local network", () => {
    for (const url of ["http://localhost:3000/", "http://LOCALHOST/", "http://api.localhost/", "http://printer.local/",
      "http://metadata.google.internal/computeMetadata/v1/", "http://nas.home.arpa/", "http://ava-worker:8080/healthz", "http://intranet/"]) {
      expect(refused(url)).toMatch(/local network name/);
    }
  });

  it("refuses what is not a URL at all", () => {
    expect(refused("not a url")).toMatch(/not a web address/);
  });

  it("lets a caller decide which addresses count as public, for a local fixture", () => {
    expect(assertPublicHttpUrl("http://127.0.0.1:9/", { isAllowedAddress: a => a === "127.0.0.1" }).port).toBe("9");
    expect(() => assertPublicHttpUrl("http://127.0.0.2/", { isAllowedAddress: a => a === "127.0.0.1" })).toThrow(UnsafeUrlError);
  });
});
