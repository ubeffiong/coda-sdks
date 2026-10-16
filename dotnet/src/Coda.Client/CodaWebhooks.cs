using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Coda.Client;

/// <summary>Verification of CODA webhooks (Standard Webhooks signatures).</summary>
public static class CodaWebhooks
{
    /// <summary>
    /// True when the delivery was signed by CODA with <paramref name="secret"/> ("whsec_...") and is
    /// within <paramref name="tolerance"/> (default 5 minutes). Pass the raw body exactly as received.
    /// </summary>
    public static bool Verify(string secret, string? id, string? timestamp, string? signature, string body, DateTimeOffset? now = null, TimeSpan? tolerance = null)
    {
        ArgumentNullException.ThrowIfNull(secret);
        ArgumentNullException.ThrowIfNull(body);
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(signature)
            || !long.TryParse(timestamp, NumberStyles.None, CultureInfo.InvariantCulture, out var ts))
        {
            return false;
        }

        var current = (now ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds();
        if (Math.Abs(current - ts) > (tolerance ?? TimeSpan.FromMinutes(5)).TotalSeconds)
        {
            return false;
        }

        var key = Convert.FromBase64String(secret.StartsWith("whsec_", StringComparison.Ordinal) ? secret[6..] : secret);
        var expected = Encoding.ASCII.GetBytes("v1," + Convert.ToBase64String(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes($"{id}.{timestamp}.{body}"))));
        return signature.Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Any(candidate => CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(candidate), expected));
    }

    /// <summary>Header-collection overload (names are case-insensitive).</summary>
    public static bool Verify(string secret, IEnumerable<KeyValuePair<string, string>> headers, string body, DateTimeOffset? now = null, TimeSpan? tolerance = null)
    {
        ArgumentNullException.ThrowIfNull(headers);
        var h = headers.ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.OrdinalIgnoreCase);
        return Verify(secret, h.GetValueOrDefault("webhook-id"), h.GetValueOrDefault("webhook-timestamp"), h.GetValueOrDefault("webhook-signature"), body, now, tolerance);
    }
}
