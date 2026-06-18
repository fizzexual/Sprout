# Types & objects

A **type** is a blueprint for an object — it bundles **fields** (the data) with **methods**
(the behaviour that works on that data). It's Sprout's version of a class.

```sprout
type Point:
    make x
    make y = 0

    task length(self):
        give sqrt(self.x * self.x + self.y * self.y)

    task move(self, dx, dy):
        set self.x = self.x + dx
        set self.y = self.y + dy
        give self

make p = Point(3, 4)
show p.x            ~ 3
show p.length()     ~ 5
p.move(1, 1)
show p.x            ~ 4
```

## Defining a type

```sprout
type Name:
    make field1
    make field2 = <default>      ~ a default value is optional
    task method(self, ...):      ~ the first input is the object itself
        ...
```

- Write it with the `type` keyword, a name, and a `:` — then an indented body.
- **Fields** are declared with `make`. A field with no default (`make x`) is **required**
  when you build the object; a field with a default (`make y = 0`) may be left out.
- **Methods** are tasks written inside the type. Their **first input is the object**, named
  `self` by convention. A method reads and writes the object's fields through `self`.

## Making an object

Call the type like a function. Arguments fill the fields **in the order they're declared**:

```sprout
make p = Point(3, 4)     ~ x = 3, y = 4
make q = Point(10)       ~ x = 10, y = 0 (default)
```

- Too many arguments → `Point takes at most 2 value(s)…`
- A required field with no argument → `Point needs a value for 'x'.`

## Fields: read and write

Use `.field` to read, and `set obj.field = …` to write. Fields nest, and `set` reaches all
the way in:

```sprout
make ln = Line(Point(2, 0), Point(9, 0))
show ln.a.x              ~ 2
set ln.a.x = 5           ~ writes through to the inner Point
show ln.a.x              ~ 5
```

## Calling methods

`obj.method(args)` runs the method with `obj` bound to `self`:

```sprout
p.move(1, 1)             ~ self = p
show p.length()
```

If a method `give`s `self`, calls **chain**:

```sprout
show Point(0, 0).move(3, 4).length()    ~ 5
```

## Type tags

`kind_of` returns the type's name, and `show` prints it:

```sprout
make p = Point(3, 4)
show kind_of(p)          ~ "Point"
show p                   ~ Point {x: 3, y: 4}
```

## Polymorphism

Different types can share a method name; Sprout picks the right one at run time based on the
object — so you can treat a mixed list uniformly:

```sprout
type Circle:
    make radius
    task area(self):
        give 3.14159 * self.radius * self.radius

type Rectangle:
    make width
    make height
    task area(self):
        give self.width * self.height

for each s in [Circle(2), Rectangle(3, 4)]:
    show s.area()        ~ each calls its own area()
```

## Copies are independent

`copy(obj)` makes a deep, independent copy that keeps its type:

```sprout
make p = Point(3, 4)
make c = copy(p)
set c.x = 99
show p.x                 ~ 3  (unchanged)
show kind_of(c)          ~ "Point"
```

## Inheritance

A type can build on another with `from`. The child **inherits** the parent's fields and
methods, and may add its own or **override** them.

```sprout
type Animal:
    make name
    make legs = 4
    task sound(self):
        give "..."
    task describe(self):
        give self.name + " says " + self.sound()

type Dog from Animal:        ~ a Dog is an Animal, plus a breed
    make breed
    task sound(self):        ~ override the parent's sound()
        give "woof"

make d = Dog("Rex", 4, "Lab")   ~ name, legs (inherited), breed (own) — parent fields first
show d.describe()               ~ "Rex says woof"
```

- **Fields are inherited, parent-first.** A constructor fills the ancestor's fields, then the
  child's, in declaration order: `Dog("Rex", 4, "Lab")` is `name`, `legs`, `breed`.
- **Methods are inherited.** `d` can call `describe()` even though only `Animal` defines it.
- **Overriding uses virtual dispatch.** `Dog` redefines `sound()`; the inherited `describe()`
  calls `self.sound()`, which runs **Dog's** version — so `describe()` says "woof", not "...".
- One parent per type (single inheritance); chains are fine (`type Puppy from Dog:`).

### `is_a` — checking the type

`is_a(value, "TypeName")` is true if the value is that type **or any ancestor** (like Java's
`instanceof`). `kind_of` always gives the *concrete* type.

```sprout
make d = Dog("Rex", 4, "Lab")
show kind_of(d)        ~ "Dog"
show is_a(d, "Dog")    ~ yes
show is_a(d, "Animal") ~ yes   (an ancestor)
show is_a(d, "Cat")    ~ no
```

## Operators & custom display

A type can decide what `+`, `==`, `<` — and even how the object **prints** — mean, so your own
types behave like built-in values.

```sprout
type Money:
    make cents
    task plus(self, other):
        give Money(self.cents + other.cents)
    task compare(self, other):
        give self.cents - other.cents
    task text(self):
        give "$" + (self.cents / 100)

make a = Money(500)
make b = Money(750)
show a + b        ~ $12.5         (plus, then text)
show a < b        ~ yes           (compare)
show [a, b]       ~ [$5, $7.5]    (text is used inside the list, too)
```

Define any of these methods and the matching operator calls it:

| Method | Drives | Should give |
| --- | --- | --- |
| `plus(self, other)` | `a + b` | the result |
| `minus(self, other)` | `a - b` | the result |
| `multiply(self, other)` | `a * b` | the result |
| `divide(self, other)` | `a / b` | the result |
| `modulo(self, other)` | `a % b` | the result |
| `equals(self, other)` | `a == b` and `a != b` | yes/no |
| `compare(self, other)` | `a < b`, `<=`, `>`, `>=` | a number `< 0`, `0`, or `> 0` |
| `text(self)` | `show a`, f-strings, `"" + a` | the text to display |

- Dispatch is on the **left** operand: `a + b` uses `a`'s `plus`. (Right-hand dispatch like
  `2 + money` is a planned refinement.)
- A type without these methods uses the normal rules — `+` is for numbers/text, `==` compares
  by value. Plain maps and lists are unaffected.
- `text(self)` is used everywhere an object becomes text, **including inside lists and maps**.

## Notes & current limits

- An object **is** a tagged map underneath, so it's a value like any other — store it in a
  list or map, pass it to a task, return it.
- `self` is just the conventional name for the first parameter — you may name it anything, but
  `self` reads clearly.
- Types are defined at the **top level** of a file (like tasks), not inside a task or block.
- **Interfaces and type annotations aren't here yet** — they're the next steps on the
  [roadmap](roadmap.md). There's no `super` call to a parent's overridden method yet, either.
