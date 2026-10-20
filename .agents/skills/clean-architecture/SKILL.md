---
name: clean-architecture
description: Review code and provide design guidance based on Clean Architecture principles. Checks dependency rule, layer separation, crossing boundaries, and SOLID principles. Use when asked to review architecture, check dependencies, or design with clean architecture principles.
---

# Clean Architecture Review Skill

## Overview

This skill analyzes and reviews code based on Robert C. Martin's (Uncle Bob) Clean Architecture principles.

## When to Use

- When user requests "clean architecture" review
- When asked about "architecture review", "dependency check", or "layer separation"
- When designing new features with clean architecture

## Instructions

### 1. Project Structure Analysis

First, understand the project's directory structure:
- Check if layers are separated
- Examine module/package structure
- Identify dependency direction

### 2. The Dependency Rule

**Core Principle**: Source code dependencies must only point inward (toward higher-level policies).

```
┌─────────────────────────────────────────────────────────┐
│                  Frameworks & Drivers                    │
│  ┌─────────────────────────────────────────────────┐    │
│  │              Interface Adapters                  │    │
│  │  ┌─────────────────────────────────────────┐    │    │
│  │  │              Use Cases                   │    │    │
│  │  │  ┌─────────────────────────────────┐    │    │    │
│  │  │  │           Entities              │    │    │    │
│  │  │  └─────────────────────────────────┘    │    │    │
│  │  └─────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
                    ← Dependencies flow inward
```

Checklist:
- Do inner layers avoid referencing outer layers?
- Are Entities unaware of Use Cases, Adapters, and Infrastructure?
- Do Use Cases avoid directly referencing Adapters or Infrastructure?
- Is DIP applied when crossing boundaries?

### 2-1. Crossing Boundaries

The flow of control and source code dependency can point in opposite directions.

```
Controller → Use Case → Presenter
     ↓           ↓           ↑
[dependency] [dependency] [inverted!]
```

Example: When Use Case needs to call Presenter
- Directly referencing Presenter from Use Case violates the dependency rule
- **Solution**: Define Output Port (interface) inside Use Case, Presenter implements it

```typescript
// Use Case Layer (inner)
interface OrderOutputPort {
  presentOrder(order: OrderData): void;
}

class CreateOrderUseCase {
  constructor(private outputPort: OrderOutputPort) {}
  execute() {
    // ... business logic
    this.outputPort.presentOrder(orderData);
  }
}

// Adapter Layer (outer) - depends on Use Case
class OrderPresenter implements OrderOutputPort {
  presentOrder(order: OrderData): void {
    // Transform for UI
  }
}
```

### 2-2. What Data Crosses Boundaries

**Principle**: Data crossing boundaries should be simple data structures (DTOs).

```typescript
// Bad: Passing Entity directly
class GetUserUseCase {
  execute(): User { // Returning Entity directly
    return this.userRepository.findById(id);
  }
}

// Good: Transform to DTO
class GetUserUseCase {
  execute(): UserResponseDTO { // Simple data structure
    const user = this.userRepository.findById(id);
    return { id: user.id, name: user.name };
  }
}
```

Checklist:
- Are Entities or Database Rows not crossing boundaries directly?
- Are external framework data formats not penetrating inner layers?
- Are appropriate DTOs defined for each layer?

### 3. Layer Structure Review

#### Entities (Domain Layer)
- Contains core business rules
- No external dependencies
- Least likely to change

Checklist:
- Does Entity avoid depending on frameworks?
- Does it contain only pure business logic?
- Are there no external library imports?

#### Use Cases (Application Layer)
- Application-specific business rules
- Orchestrates Entities to implement features
- Defines interfaces for external systems

Checklist:
- Does each Use Case have a single responsibility?
- Are Input/Output ports clearly defined?
- Does it use Repository interfaces (not implementations)?

#### Interface Adapters
- Handles data transformation
- Contains Controllers, Presenters, Gateways
- Can apply patterns like MVC, MVVM

Checklist:
- Is transformation between DTOs and Entities happening here?
- Is the separation between external and internal formats clear?

#### Frameworks & Drivers (Infrastructure Layer)
- DB, Web Framework, external services
- Mostly glue code
- Most likely to change

Checklist:
- Are framework dependencies isolated to this layer?
- Are Repository implementations located here?

### 4. SOLID Principles Review

Object-oriented design principles used in Clean Architecture implementation. **DIP** is essential for Crossing Boundaries.

| Principle | Description | Clean Architecture Relevance |
|-----------|-------------|------------------------------|
| **SRP** | A class should have only one reason to change | Layer responsibility separation |
| **OCP** | Open for extension, closed for modification | Extension through interfaces |
| **LSP** | Subtypes must be substitutable for base types | Implementation replaceability |
| **ISP** | Don't depend on interfaces you don't use | Port interface segregation |
| **DIP** | Depend on abstractions, not concretions | **Core of Crossing Boundaries** |

## Output Format

Provide review results in this format:

```markdown
# Clean Architecture Review Report

## Summary
- Overall Assessment: [Good/Needs Improvement/Critical]
- Key findings summary

## Dependency Rule Analysis
- List of violations
- Improvement suggestions

## Layer Structure Review
### Entities: [Good/Needs Improvement]
### Use Cases: [Good/Needs Improvement]
### Interface Adapters: [Good/Needs Improvement]
### Infrastructure: [Good/Needs Improvement]

## Recommendations
1. High priority improvements
2. Medium priority improvements
3. Long-term suggestions
```

## Important Notes

### Clean Architecture is Not a Silver Bullet

- Not all projects require exactly 4 layers
- Layer count is flexible as long as the dependency rule is followed
- Apply according to project scale and complexity

### Common Pitfalls to Avoid

1. **Over-obsession with layers**: Layer separation is not the goal itself
2. **Over-abstraction**: Creating interfaces with only one implementation
3. **Superficial adoption**: Relying on IDE refactoring while ignoring actual dependency rules
4. **Over-engineering for the future**: Adding complexity for unlikely changes

### Key Questions

Always consider these questions during review:
- "Does this separation actually provide benefits?"
- "Is the dependency rule truly being followed?"
- "Is the impact scope minimized when changes occur?"

### Practical Verification

Ask yourself if you're really benefiting from Clean Architecture:
- Is it the layer separation that helps, or just IDE auto-refactoring?
- Is a Repository interface with only one implementation really necessary?
- Are you over-abstracting for a 0.001% chance of future change?
- Can you rename a class in outer modules without affecting inner modules?

## Language-Specific Examples

### TypeScript/JavaScript
```typescript
// Good: Dependency Inversion
interface UserRepository {
  findById(id: string): Promise<User>;
}

class GetUserUseCase {
  constructor(private userRepository: UserRepository) {}
}

// Bad: Depending on concrete implementation
class GetUserUseCase {
  constructor(private userRepository: PostgresUserRepository) {}
}
```

### Python
```python
# Good: Interface definition using Protocol
from typing import Protocol

class UserRepository(Protocol):
    def find_by_id(self, id: str) -> User: ...

# Bad: Direct implementation import
from infrastructure.postgres import PostgresUserRepository
```

### Java/Kotlin
```kotlin
// Good: Interface segregation
interface UserRepository {
    fun findById(id: String): User?
}

class GetUserUseCase(
    private val userRepository: UserRepository
)

// Bad: Using concrete implementation
class GetUserUseCase(
    private val userRepository: JpaUserRepository
)
```

## References

- [The Clean Architecture - Robert C. Martin](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)
- Clean Architecture: A Craftsman's Guide to Software Structure and Design (Book)
