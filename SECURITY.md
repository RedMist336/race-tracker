# Security & Configuration Guide

## ⚠️ Important: Protecting Your Credentials

This project requires WiFi credentials and server addresses to operate. **These must NEVER be committed to version control.**

### Configuration Files

#### Never Commit
- ❌ `firmware/tracker/include/config.h`
- ❌ `firmware/gateway/include/config.h`
- ❌ `server/.env` (if using environment variables)

These files are already in `.gitignore` to prevent accidental commits.

#### Use as Templates
- ✅ `firmware/tracker/include/config.example.h`
- ✅ `firmware/gateway/include/config.example.h`

### Setup Instructions

#### 1. Tracker Configuration

```bash
cp firmware/tracker/include/config.example.h firmware/tracker/include/config.h
```

Edit `firmware/tracker/include/config.h` and fill in:
```cpp
#define CAR_ID 15                      // Change for each unit (11-30)
#define TRACKER_NAME "U15"             // Human-readable label
#define WIFI_SSID "YOUR_NETWORK"       // Your WiFi network name
#define WIFI_PASSWORD "YOUR_PASSWORD"  // Your WiFi password
#define SERVER_HOST "192.168.0.1"      // Server IP or hostname
```

#### 2. Gateway Configuration

```bash
cp firmware/gateway/include/config.example.h firmware/gateway/include/config.h
```

Edit `firmware/gateway/include/config.h` and fill in:
```cpp
#define WIFI_SSID "YOUR_NETWORK"
#define WIFI_PASSWORD "YOUR_PASSWORD"
#define SERVER_HOST "192.168.0.1"
#define WIFI_STATIC_IP_0 192           // Fixed gateway IP (192.168.0.2)
#define WIFI_STATIC_IP_1 168
#define WIFI_STATIC_IP_2 0
#define WIFI_STATIC_IP_3 2
```

### Security Best Practices

#### ✅ DO
- [ ] Use strong WiFi passwords (16+ characters, mixed case, numbers, symbols)
- [ ] Keep config.h files on local machines only
- [ ] Change WiFi password before deploying to multiple locations
- [ ] Use environment-specific configurations for development vs. production
- [ ] Review `.gitignore` after cloning to ensure config patterns are present

#### ❌ DON'T
- [ ] Never hardcode credentials in code that gets committed
- [ ] Never share config.h files via email or cloud storage
- [ ] Never push config.h to GitHub or other public repositories
- [ ] Never use the same credentials across different networks/environments
- [ ] Never publish real WiFi credentials in documentation or issues

### Incident Response

If credentials are ever accidentally committed:

#### On Local Machine
```bash
# Remove from current working directory (keeps in history)
git rm --cached firmware/tracker/include/config.h
echo "firmware/tracker/include/config.h" >> .gitignore
git add .gitignore
git commit -m "Add config.h to .gitignore"

# To remove from history entirely (destructive):
git filter-branch --tree-filter 'rm -f firmware/tracker/include/config.h' -- --all
git push origin master --force
```

#### At Network Level
1. **Immediately change WiFi password** at the access point
2. **Rotate any exposed server credentials**
3. **Check logs** for unauthorized connections during exposure window
4. **Document the incident** for post-mortem analysis

### Git Configuration

Verify protection is active:

```bash
# Check if config.h would be ignored
git check-ignore firmware/tracker/include/config.h

# View current .gitignore rules
cat .gitignore | grep config
```

### Environment Variables (Alternative Approach)

For advanced deployments, consider using environment variables instead of config files:

```cpp
const char* wifi_ssid = std::getenv("RACE_WIFI_SSID");
const char* wifi_password = std::getenv("RACE_WIFI_PASSWORD");
```

Store these in:
- `.env` files (add to .gitignore)
- System environment variables
- CI/CD secrets (GitHub Actions, etc.)
- Secure credential managers

### References

- [GitHub: Removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
- [OWASP: Sensitive Data Exposure](https://owasp.org/www-project-top-ten/)
- [CWE-798: Use of Hard-coded Credentials](https://cwe.mitre.org/data/definitions/798.html)

### Questions?

If you find a security issue or have concerns about credential exposure, please:
1. Do not post credentials in GitHub issues
2. Contact the maintainer privately
3. Refer to any existing security policy (SECURITY.md)

---

**Last Updated:** May 12, 2026  
**Status:** ✅ Repository clean - no credentials in public history
