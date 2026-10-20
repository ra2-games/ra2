---
name: kent-beck-style
description: Review code following Kent Beck's refactoring philosophy and simple design principles. Detects code smells, guides refactoring techniques, and promotes incremental improvement (YAGNI, KISS). Use when reviewing code quality, refactoring, or improving code readability.
---

# Kent Beck Style Coding Review Skill

## Overview

This skill analyzes and reviews code based on Kent Beck's refactoring philosophy and simple design principles. It focuses on code smells detection, refactoring techniques, and incremental design improvement.

> "Any fool can write code that a computer can understand. Good programmers write code that humans can understand." - Martin Fowler (Refactoring, foreword by Kent Beck)

## When to Use

- When user requests "code smell" detection or "refactoring" guidance
- When asked about "code quality", "readability", or "maintainability"
- When reviewing code for improvement opportunities
- When asked about "YAGNI", "KISS", or "simple design"
- When improving naming, extracting methods, or removing duplication

## Core Design Principles

### Simple Design (4 Rules of Simple Design)

Kent Beck's rules in priority order:

1. **Passes the Tests** - Code must work correctly
2. **Reveals Intent** - Code should clearly express its purpose
3. **No Duplication** - DRY (Don't Repeat Yourself)
4. **Fewest Elements** - Minimize classes, methods, and code

### YAGNI (You Aren't Gonna Need It)

- Don't add functionality until it's actually needed
- Avoid speculative generality
- Build for today's requirements, not imagined futures

```typescript
// Bad: Speculative generality
interface DataProcessor<T, U, V> {
  process(input: T, options: U): V;
  processAsync(input: T, options: U): Promise<V>;
  processBatch(inputs: T[], options: U): V[];
  // We only need one sync method right now!
}

// Good: Build what you need
interface DataProcessor {
  process(input: string): Result;
}
```

### KISS (Keep It Simple, Stupid)

- Prefer simple solutions over clever ones
- Complexity is the enemy of maintainability
- If it's hard to explain, it's probably too complex

### Incremental Design

- Make small, safe changes
- Refactor continuously as you code
- Design emerges through refactoring

## Code Smells Catalog

### 1. Bloaters

Code that has grown too large to handle.

#### Long Method
- Methods doing too many things
- Difficult to understand at a glance
- **Refactoring**: Extract Method, Replace Temp with Query

```typescript
// Bad: Long method doing many things
function processOrder(order: Order) {
  // Validate order (10 lines)
  // Calculate discount (15 lines)
  // Apply tax (10 lines)
  // Update inventory (20 lines)
  // Send notification (15 lines)
  // Generate invoice (25 lines)
}

// Good: Extracted into focused methods
function processOrder(order: Order) {
  validateOrder(order);
  const discount = calculateDiscount(order);
  const total = applyTax(order.subtotal - discount);
  updateInventory(order.items);
  sendOrderConfirmation(order);
  generateInvoice(order, total);
}
```

#### Large Class
- Class with too many responsibilities
- Too many instance variables
- **Refactoring**: Extract Class, Extract Subclass

#### Primitive Obsession
- Overuse of primitives instead of small objects
- Using strings for phone numbers, money, etc.
- **Refactoring**: Replace Primitive with Object, Introduce Parameter Object

```typescript
// Bad: Primitive obsession
function createUser(
  name: string,
  email: string,
  phone: string,
  street: string,
  city: string,
  zipCode: string
) { ... }

// Good: Value objects
function createUser(
  name: Name,
  email: Email,
  phone: Phone,
  address: Address
) { ... }
```

#### Long Parameter List
- Methods with too many parameters
- Hard to understand and call correctly
- **Refactoring**: Introduce Parameter Object, Preserve Whole Object

#### Data Clumps
- Groups of data that always appear together
- **Refactoring**: Extract Class, Introduce Parameter Object

### 2. Object-Orientation Abusers

Improper application of OO principles.

#### Switch Statements
- Complex switch/case or if/else chains
- Often indicates missing polymorphism
- **Refactoring**: Replace Conditional with Polymorphism, Replace Type Code with Subclasses

```typescript
// Bad: Switch statement
function calculateArea(shape: Shape): number {
  switch (shape.type) {
    case 'circle':
      return Math.PI * shape.radius ** 2;
    case 'rectangle':
      return shape.width * shape.height;
    case 'triangle':
      return (shape.base * shape.height) / 2;
  }
}

// Good: Polymorphism
interface Shape {
  calculateArea(): number;
}

class Circle implements Shape {
  calculateArea(): number {
    return Math.PI * this.radius ** 2;
  }
}
```

#### Temporary Field
- Fields only set in certain circumstances
- **Refactoring**: Extract Class, Introduce Null Object

#### Refused Bequest
- Subclass doesn't use inherited methods
- **Refactoring**: Replace Inheritance with Delegation

#### Alternative Classes with Different Interfaces
- Classes doing the same thing with different method names
- **Refactoring**: Rename Method, Extract Superclass

### 3. Change Preventers

Code that makes changes difficult.

#### Divergent Change
- One class changes for multiple reasons
- Violates Single Responsibility Principle
- **Refactoring**: Extract Class

#### Shotgun Surgery
- One change requires modifications in many classes
- **Refactoring**: Move Method, Move Field, Inline Class

#### Parallel Inheritance Hierarchies
- Creating a subclass requires creating another subclass elsewhere
- **Refactoring**: Move Method, Move Field

### 4. Dispensables

Code that is unnecessary.

#### Duplicate Code
- Same code structure in multiple places
- **Refactoring**: Extract Method, Extract Class, Pull Up Method

```typescript
// Bad: Duplicate code
function validateEmail(email: string): boolean {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

function isValidEmail(input: string): boolean {
  const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return pattern.test(input);
}

// Good: Single source of truth
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}
```

#### Dead Code
- Unreachable or unused code
- **Refactoring**: Remove Dead Code

#### Speculative Generality
- Unused abstractions created "just in case"
- **Refactoring**: Collapse Hierarchy, Inline Class, Remove Parameter

#### Comments (as smell)
- Comments explaining what code does (instead of why)
- Often indicates code that should be clearer
- **Refactoring**: Extract Method, Rename Method

```typescript
// Bad: Comment explaining what
// Check if user is adult
if (user.age >= 18) { ... }

// Good: Self-documenting code
const LEGAL_ADULT_AGE = 18;
if (user.isAdult()) { ... }

// Good use of comments: explaining why
// Using >= instead of > because legal age includes 18th birthday
if (user.age >= LEGAL_ADULT_AGE) { ... }
```

### 5. Couplers

Code with excessive coupling.

#### Feature Envy
- Method uses another class's data more than its own
- **Refactoring**: Move Method, Extract Method

```typescript
// Bad: Feature envy
class OrderPrinter {
  print(order: Order) {
    console.log(`Order: ${order.id}`);
    console.log(`Customer: ${order.customer.name}`);
    console.log(`Total: ${order.items.reduce((sum, item) =>
      sum + item.price * item.quantity, 0)}`);
  }
}

// Good: Move calculation to Order
class Order {
  getTotal(): number {
    return this.items.reduce((sum, item) =>
      sum + item.price * item.quantity, 0);
  }
}
```

#### Inappropriate Intimacy
- Classes too dependent on each other's internals
- **Refactoring**: Move Method, Move Field, Change Bidirectional to Unidirectional

#### Message Chains
- Long chains of method calls (a.b().c().d())
- **Refactoring**: Hide Delegate, Extract Method

#### Middle Man
- Class that only delegates to another class
- **Refactoring**: Remove Middle Man, Inline Method

## Refactoring Techniques

### Composing Methods

#### Extract Method
The most important refactoring. Turn code fragments into methods with intention-revealing names.

```typescript
// Before
function printOwing() {
  printBanner();

  // Print details
  console.log(`name: ${name}`);
  console.log(`amount: ${getOutstanding()}`);
}

// After
function printOwing() {
  printBanner();
  printDetails();
}

function printDetails() {
  console.log(`name: ${name}`);
  console.log(`amount: ${getOutstanding()}`);
}
```

#### Inline Method
When method body is as clear as its name.

#### Replace Temp with Query
Replace temporary variables with method calls.

```typescript
// Before
const basePrice = quantity * itemPrice;
if (basePrice > 1000) {
  return basePrice * 0.95;
}

// After
if (getBasePrice() > 1000) {
  return getBasePrice() * 0.95;
}

function getBasePrice() {
  return quantity * itemPrice;
}
```

### Moving Features

#### Move Method
Move method to the class that uses it most.

#### Move Field
Move field to where it's used most.

#### Extract Class
When a class does work that should be done by two.

#### Inline Class
When a class isn't doing much.

### Organizing Data

#### Replace Magic Number with Symbolic Constant
Always name your constants!

```typescript
// Bad: Magic numbers
if (age >= 18) { ... }
const tax = price * 0.1;
setTimeout(callback, 86400000);

// Good: Named constants
const LEGAL_ADULT_AGE = 18;
const TAX_RATE = 0.1;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

if (age >= LEGAL_ADULT_AGE) { ... }
const tax = price * TAX_RATE;
setTimeout(callback, MILLISECONDS_PER_DAY);
```

#### Encapsulate Field
Make fields private, provide accessors.

#### Replace Data Value with Object
When a data item needs additional behavior.

### Simplifying Conditionals

#### Decompose Conditional
Extract condition and branches into methods.

```typescript
// Before
if (date.before(SUMMER_START) || date.after(SUMMER_END)) {
  charge = quantity * winterRate + winterServiceCharge;
} else {
  charge = quantity * summerRate;
}

// After
if (isWinter(date)) {
  charge = winterCharge(quantity);
} else {
  charge = summerCharge(quantity);
}
```

#### Consolidate Conditional Expression
Combine conditionals that have the same result.

#### Replace Nested Conditional with Guard Clauses
Use early returns to reduce nesting.

```typescript
// Before
function getPayAmount() {
  let result;
  if (isDead) {
    result = deadAmount();
  } else {
    if (isSeparated) {
      result = separatedAmount();
    } else {
      if (isRetired) {
        result = retiredAmount();
      } else {
        result = normalPayAmount();
      }
    }
  }
  return result;
}

// After
function getPayAmount() {
  if (isDead) return deadAmount();
  if (isSeparated) return separatedAmount();
  if (isRetired) return retiredAmount();
  return normalPayAmount();
}
```

### Simplifying Method Calls

#### Rename Method
Names should reveal intent.

```typescript
// Bad names
function calc(a, b) { ... }
function doIt() { ... }
function process(data) { ... }

// Good names
function calculateTotalPrice(items, taxRate) { ... }
function sendOrderConfirmation() { ... }
function validateUserCredentials(credentials) { ... }
```

#### Add/Remove Parameter
Keep parameter lists minimal and meaningful.

#### Introduce Parameter Object
Group related parameters.

#### Preserve Whole Object
Pass the object instead of extracting values.

## Intention-Revealing Code

### Magic Numbers and Literals

**Always replace magic numbers with named constants.**

```typescript
// Bad
if (response.status === 200) { ... }
if (password.length < 8) { ... }
const timeout = 30000;

// Good
const HTTP_OK = 200;
const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_TIMEOUT_MS = 30000;

if (response.status === HTTP_OK) { ... }
if (password.length < MIN_PASSWORD_LENGTH) { ... }
const timeout = DEFAULT_TIMEOUT_MS;
```

### Naming Guidelines

- **Variables**: Nouns describing what they hold
- **Functions**: Verbs describing what they do
- **Booleans**: Questions that can be answered yes/no
- **Classes**: Nouns describing what they represent

```typescript
// Bad naming
const d = new Date();
const flag = true;
function calc() { ... }

// Good naming
const currentDate = new Date();
const isUserAuthenticated = true;
function calculateShippingCost() { ... }
```

### Self-Documenting Code

Code should express its intent without comments.

```typescript
// Bad: Needs comment to explain
// Check if user can access premium content
if (user.subscription !== null &&
    user.subscription.endDate > new Date() &&
    user.subscription.tier === 'premium') { ... }

// Good: Self-documenting
if (user.hasPremiumAccess()) { ... }

class User {
  hasPremiumAccess(): boolean {
    return this.subscription?.isActive() &&
           this.subscription?.tier === SubscriptionTier.PREMIUM;
  }
}
```

## Working in Small Steps

### The Rhythm of Refactoring

1. **Make a small change**
2. **Run tests**
3. **Commit if green**
4. **Repeat**

### Safe Refactoring Steps

- Change one thing at a time
- Keep the code working at all times
- If tests fail, revert and try smaller steps
- Commit frequently

### Example: Extract Method in Small Steps

```typescript
// Step 1: Identify code to extract
function printOwing() {
  printBanner();

  // START: Code to extract
  console.log(`name: ${name}`);
  console.log(`amount: ${getOutstanding()}`);
  // END: Code to extract
}

// Step 2: Create new method with extracted code
function printDetails() {
  console.log(`name: ${name}`);
  console.log(`amount: ${getOutstanding()}`);
}

// Step 3: Call new method from original location
function printOwing() {
  printBanner();
  printDetails();
}

// Step 4: Run tests, commit
```

## Output Format

Provide review results in this format:

```markdown
# Kent Beck Style Code Review Report

## Summary
- Overall Code Health: [Good/Needs Improvement/Critical]
- Key findings summary

## Code Smells Detected

### [Smell Category]: [Specific Smell]
- **Location**: file:line
- **Description**: What the problem is
- **Impact**: Why it matters
- **Suggested Refactoring**: How to fix it

## Refactoring Recommendations

### High Priority
1. [Most impactful improvements]

### Medium Priority
1. [Moderate improvements]

### Low Priority (Nice to Have)
1. [Minor improvements]

## Positive Aspects
- What the code does well
```

## Language-Specific Examples

### TypeScript/JavaScript

```typescript
// Code Smell: Primitive Obsession + Magic Numbers
function createDiscount(percent: number, startDate: string, endDate: string) {
  if (percent < 0 || percent > 100) throw new Error('Invalid');
  // ...
}

// Refactored
const MIN_DISCOUNT_PERCENT = 0;
const MAX_DISCOUNT_PERCENT = 100;

class DiscountPercent {
  constructor(private value: number) {
    if (value < MIN_DISCOUNT_PERCENT || value > MAX_DISCOUNT_PERCENT) {
      throw new InvalidDiscountError(value);
    }
  }
}

class DateRange {
  constructor(
    private start: Date,
    private end: Date
  ) {
    if (start > end) throw new InvalidDateRangeError();
  }
}

function createDiscount(percent: DiscountPercent, period: DateRange) { ... }
```

### Python

```python
# Code Smell: Long Method + Feature Envy
def process_order(order):
    # Validation (should be in Order)
    if order['items'] is None or len(order['items']) == 0:
        raise ValueError('Empty order')

    # Calculation (should be in Order)
    total = 0
    for item in order['items']:
        total += item['price'] * item['quantity']

    # More processing...

# Refactored
class Order:
    def __init__(self, items: list[OrderItem]):
        self._validate_items(items)
        self.items = items

    def _validate_items(self, items):
        if not items:
            raise EmptyOrderError()

    def calculate_total(self) -> Money:
        return sum(item.subtotal for item in self.items)

def process_order(order: Order):
    total = order.calculate_total()
    # Processing with clear responsibilities...
```

### Java/Kotlin

```kotlin
// Code Smell: Switch Statement + Primitive Obsession
fun calculateShipping(type: String, weight: Double): Double {
    return when (type) {
        "standard" -> weight * 1.5
        "express" -> weight * 3.0
        "overnight" -> weight * 5.0
        else -> throw IllegalArgumentException()
    }
}

// Refactored
sealed class ShippingMethod {
    abstract fun calculateCost(weight: Weight): Money

    object Standard : ShippingMethod() {
        private const val RATE_PER_KG = 1.5
        override fun calculateCost(weight: Weight) =
            Money(weight.kilograms * RATE_PER_KG)
    }

    object Express : ShippingMethod() {
        private const val RATE_PER_KG = 3.0
        override fun calculateCost(weight: Weight) =
            Money(weight.kilograms * RATE_PER_KG)
    }

    object Overnight : ShippingMethod() {
        private const val RATE_PER_KG = 5.0
        override fun calculateCost(weight: Weight) =
            Money(weight.kilograms * RATE_PER_KG)
    }
}
```

## References

- [Refactoring: Improving the Design of Existing Code - Martin Fowler (with Kent Beck)](https://refactoring.com/)
- [Implementation Patterns - Kent Beck](https://www.amazon.com/Implementation-Patterns-Kent-Beck/dp/0321413091)
- [Refactoring Catalog](https://refactoring.com/catalog/)
- [Code Smells](https://refactoring.guru/refactoring/smells)
