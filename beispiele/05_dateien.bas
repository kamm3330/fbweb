' Dateioperationen - die Datei landet im selben Ordner wie dieses Programm
Dim As Integer f = FreeFile
Print "Arbeitsverzeichnis: "; CurDir

Open "testdaten.txt" For Output As #f
For i As Integer = 1 To 5
    Print #f, "Zeile"; i; " - erstellt am "; Date; " um "; Time
Next
Close #f
Print "testdaten.txt geschrieben."
Print

Dim As String zeile
f = FreeFile
Open "testdaten.txt" For Input As #f
Do Until EOF(f)
    Line Input #f, zeile
    Print "Gelesen: "; zeile
Loop
Close #f

Print
Print "Dateien im Ordner:"
Dim As String d = Dir("*")
Do While Len(d)
    Print "  "; d
    d = Dir()
Loop
