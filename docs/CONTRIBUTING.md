# Contributing to HomeChannel

Thank you for your interest in contributing to HomeChannel! This document provides guidelines and workflows for contributing to the project.

## Project Overview

HomeChannel is a minimal-dependency WebRTC datachannel solution for remote access to home systems. It uses pure JavaScript (no transpilation/bundling) and follows strict guidelines for security and simplicity.

**Key Principles:**
- Pure JavaScript (ES modules for client, CommonJS/ES modules for Node.js)
- Zero build tools
- Minimal dependencies (Node.js built-ins only)
- No WebSockets (HTTP/HTTPS polling for client-coordinator)
- Alpha status (API subject to change)

## Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/denisps/homechannel.git
   cd homechannel
   ```

2. **Install dependencies** (each module separately)
   ```bash
   cd shared && npm install
   cd ../server && npm install
   cd ../coordinator && npm install
   ```

3. **Run tests**
   ```bash
   # Test each module
   cd shared && npm test
   cd ../server && npm test
   cd ../coordinator && npm test
   ```

## Contribution Workflow

### Pre-Implementation Checklist

Before writing any code, verify:
- [ ] Requirements are clear and understood
- [ ] No forbidden practices will be used (see Coding Standards)
- [ ] Async operations will be used for all I/O
- [ ] Only Node.js built-in modules or minimal dependencies needed
- [ ] Security implications considered
- [ ] Test strategy identified

### Step-by-Step Workflow

1. **Create a new branch**
   ```bash
   git checkout -b feature/descriptive-name
   # or
   git checkout -b fix/issue-description
   ```

2. **Run tests first** (baseline verification)
   ```bash
   npm test
   ```

3. **Create tests** for your feature/bugfix
   - Add test files in the appropriate `test/` directory
   - Follow TDD (Test-Driven Development) approach
   - Test critical paths and error conditions
   - Keep tests independent

4. **Implement** your changes
   - Follow coding standards (see below)
   - Use async/await for all I/O operations
   - Implement proper error handling
   - Add meaningful error messages

5. **Run tests** to verify
   ```bash
   npm test
   ```

6. **Self-review** using code review checklist:
   - [ ] All tests pass
   - [ ] No synchronous file operations
   - [ ] No blocking operations
   - [ ] All async operations properly awaited
   - [ ] Error handling implemented
   - [ ] Input validation and sanitization
   - [ ] No debug logging (console.log) in production code
   - [ ] No custom cryptography
   - [ ] Timing-safe comparisons for secrets
   - [ ] Secure file permissions (600 for private keys)
   - [ ] Code is clear and self-documenting
   - [ ] Follows project style guidelines

7. **Optimize** if needed
   - Minimize memory allocation
   - Avoid unnecessary copying
   - Use streams for large data
   - Implement backpressure

8. **Run tests again** after optimization
   ```bash
   npm test
   ```

9. **Update documentation**
   - [ ] Update README.md if behavior/usage changes
   - [ ] Update docs/PROTOCOL.md if protocol changes
   - [ ] Update docs/SECURITY.md if security model changes
   - [ ] Update docs/ARCHITECTURE.md if design changes
   - [ ] Add code comments for complex logic

10. **Final verification**
    ```bash
    npm test  # Ensure all tests still pass
    ```

11. **Commit** with descriptive message
    ```bash
    git add -A
    git commit -m "feat: add specific feature description"
    # or
    git commit -m "fix: resolve specific issue"
    ```

    Follow [Conventional Commits](https://www.conventionalcommits.org/) format:
    - `feat:` - New feature
    - `fix:` - Bug fix
    - `docs:` - Documentation only
    - `refactor:` - Code refactoring
    - `test:` - Adding/updating tests
    - `chore:` - Maintenance tasks

12. **Push** to repository
    ```bash
    git push origin branch-name
    ```

13. **Create Pull Request**
    - Go to GitHub and create a pull request
    - Provide clear description of changes
    - Reference any related issues
    - Wait for review and address feedback

## Coding Standards

### JavaScript Style

- Use `const` and `let`, never `var`
- Arrow functions where appropriate
- Template literals for string interpolation
- Async/await over raw Promises
- Destructuring for readability
- Avoid deep nesting (max 3 levels)

### Error Handling

- Always handle errors explicitly
- Use try/catch with async/await
- Provide meaningful error messages
- Log errors appropriately (not in production with console.log)

### Module System

- ES modules for client code
- ES modules or CommonJS for Node.js code
- Clear, explicit dependencies
- No circular dependencies

### Code Organization

- Small, focused files
- Single responsibility principle
- Separation of concerns
- Descriptive names for variables and functions
- Avoid abbreviations unless widely known

## Security Guidelines

**Critical Rules:**

- ❌ Never implement custom cryptography
- ✅ Use Node.js crypto module exclusively
- ✅ Validate all signatures
- ✅ Sanitize all inputs
- ✅ Use timing-safe comparisons for secrets
- ✅ Set file permissions to 600 for private keys
- ✅ Never commit secrets or private keys

## Performance Guidelines

- Minimize memory allocation in hot paths
- Avoid unnecessary copying
- Use streams for large data
- Implement backpressure for streams
- Avoid blocking the event loop

## Testing Guidelines

- Test critical paths
- Test error conditions
- Test crypto operations thoroughly
- Test protocol edge cases
- Keep tests independent
- Mock external dependencies when appropriate
- Use descriptive test names

## Forbidden Practices

❌ Heavy frameworks (React, Vue, Angular, etc.)  
❌ WebSockets  
❌ Build tools (webpack, rollup, etc.)  
❌ TypeScript  
❌ Custom cryptography  
❌ Committing secrets  
❌ Synchronous file operations in server code  
❌ Blocking event loop  
❌ console.log in production code  

## Recommended Practices

✅ Node.js built-in modules  
✅ Minimal, audited dependencies  
✅ Clear, self-documenting code  
✅ Proper error handling  
✅ Ed448 for signatures (configurable Ed25519)  
✅ AES-GCM for authenticated encryption  
✅ Input validation and sanitization  
✅ Tests for critical functionality  
✅ Semantic versioning  
✅ Simple, maintainable code  

## Documentation

When updating documentation:

- **README.md**: User-facing usage and quick start
- **docs/PROTOCOL.md**: Protocol specifications and message formats
- **docs/SECURITY.md**: Security model and cryptographic details
- **docs/ARCHITECTURE.md**: System design and component interactions

Keep documentation:
- Accurate and up-to-date
- Clear and concise
- Well-structured with headers
- Includes code examples where helpful

## Questions or Issues?

- Check existing documentation in `docs/`
- Review closed issues for similar problems
- Open a new issue with clear description
- Provide minimal reproduction steps for bugs

## License

By contributing to HomeChannel, you agree that your contributions will be licensed under the project's license.

---

Thank you for contributing to HomeChannel!
