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

## Notes & current limits

- An object **is** a tagged map underneath, so it's a value like any other — store it in a
  list or map, pass it to a task, return it.
- `self` is just the conventional name for the first parameter — you may name it anything, but
  `self` reads clearly.
- **Inheritance, interfaces, and type annotations are not here yet** — they're the next steps
  on the roadmap. Today a type is a concrete blueprint with fields and methods.
