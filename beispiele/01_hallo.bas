' Konsolen-Ein- und -Ausgabe
Dim As String nam
Dim As Integer alter

Color 14
Print "*** Willkommen bei FreeBASIC ***"
Color 7
Print
Input "Wie heisst du"; nam
Input "Wie alt bist du"; alter

Print
Print "Hallo "; nam; "! In 10 Jahren bist du"; alter + 10; " Jahre alt."

For i As Integer = 1 To 15
    Color i
    Print "Farbe"; i
Next
Color 7
